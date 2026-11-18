import { DurableObject } from "cloudflare:workers";
//#region shared/types.ts
/**
* Shared domain types for UNO.
*
* Imported by both the Durable Object and the React client so the two can
* never drift. Dependency-free, Web-standard only — no Node built-ins.
*/
var COLORS = [
	"red",
	"yellow",
	"green",
	"blue"
];
var DEFAULT_RULES = {
	challenge: true,
	stacking: false,
	jumpIn: false,
	sevenZero: false,
	drawToMatch: false,
	turnTimer: 0,
	matchMode: "match",
	targetScore: 500
};
var NO_MOVES = {
	playable: [],
	jumpIn: [],
	canDraw: false,
	canPass: false,
	canChallenge: false,
	canCallUno: false,
	catchTargetId: null,
	mustChooseColor: false,
	mustChooseSwapTarget: false
};
//#endregion
//#region shared/deck.ts
/** Short colour code used in card ids: r/y/g/b. */
var COLOR_CODE = {
	red: "r",
	yellow: "y",
	green: "g",
	blue: "b"
};
var KIND_CODE = {
	skip: "s",
	reverse: "v",
	draw2: "d",
	wild: "w",
	wild4: "f"
};
/**
* Builds a fresh, ordered deck. Ids are stable and unique so the client can
* key animations off them and the server can verify card ownership.
*/
function createDeck() {
	const deck = [];
	for (const color of COLORS) {
		const c = COLOR_CODE[color];
		deck.push({
			id: `${c}0-0`,
			kind: "number",
			color,
			digit: 0
		});
		for (let digit = 1; digit <= 9; digit++) for (let copy = 0; copy < 2; copy++) deck.push({
			id: `${c}${digit}-${copy}`,
			kind: "number",
			color,
			digit
		});
		for (const kind of [
			"skip",
			"reverse",
			"draw2"
		]) for (let copy = 0; copy < 2; copy++) deck.push({
			id: `${c}${KIND_CODE[kind]}-${copy}`,
			kind,
			color,
			digit: null
		});
	}
	for (const kind of ["wild", "wild4"]) for (let copy = 0; copy < 4; copy++) deck.push({
		id: `${KIND_CODE[kind]}-${copy}`,
		kind,
		color: null,
		digit: null
	});
	return deck;
}
/**
* Fisher-Yates, drawing from the injected `Rng` (crypto-backed in production).
* Returns a new array; the input is untouched.
*/
function shuffle(items, rng) {
	const out = items.slice();
	for (let i = out.length - 1; i > 0; i--) {
		const j = rng.int(i + 1);
		const tmp = out[i];
		out[i] = out[j];
		out[j] = tmp;
	}
	return out;
}
function isWild(card) {
	return card.kind === "wild" || card.kind === "wild4";
}
/** End-of-round scoring value. */
function cardPoints(card) {
	switch (card.kind) {
		case "number": return card.digit ?? 0;
		case "skip":
		case "reverse":
		case "draw2": return 20;
		case "wild":
		case "wild4": return 50;
	}
}
function handPoints(hand) {
	let total = 0;
	for (const card of hand) total += cardPoints(card);
	return total;
}
/**
* Do two cards have the same face? Used by jump-in, which requires an exact
* match — same colour *and* same value.
*/
function sameFace(a, b) {
	return a.kind === b.kind && a.color === b.color && a.digit === b.digit;
}
/**
* Base playability: matches the active colour, matches the top card's
* number/symbol, or is a wild.
*
* Wild Draw Four's extra "no matching colour in hand" restriction is a
* separate concern — see `canPlay` in `engine.ts`, since it depends on the
* whole hand and on whether the challenge rule is enabled.
*/
function matches(card, top, activeColor) {
	if (isWild(card)) return true;
	if (activeColor !== null && card.color === activeColor) return true;
	if (card.kind === "number" && top.kind === "number") return card.digit === top.digit;
	return card.kind === top.kind && !isWild(top);
}
var KIND_LABEL = {
	number: "",
	skip: "Skip",
	reverse: "Reverse",
	draw2: "Draw Two",
	wild: "Wild",
	wild4: "Wild Draw Four"
};
var COLOR_LABEL = {
	red: "Red",
	yellow: "Yellow",
	green: "Green",
	blue: "Blue"
};
function colorLabel(color) {
	return COLOR_LABEL[color];
}
/** Human-readable name, e.g. "Red 7", "Blue Skip", "Wild Draw Four". */
function cardLabel(card) {
	if (card.kind === "number") return `${COLOR_LABEL[card.color]} ${card.digit}`;
	if (isWild(card)) return KIND_LABEL[card.kind];
	return `${COLOR_LABEL[card.color]} ${KIND_LABEL[card.kind]}`;
}
/** How long a player has to call UNO before the window closes. */
var UNO_WINDOW_MS = 3e3;
function fail(code, message) {
	return {
		ok: false,
		code,
		message
	};
}
function clone(state) {
	return structuredClone(state);
}
function topCard(s) {
	return s.discard.length > 0 ? s.discard[s.discard.length - 1] : null;
}
function playerIndex(s, playerId) {
	return s.players.findIndex((p) => p.id === playerId);
}
function findPlayer(s, playerId) {
	return s.players.find((p) => p.id === playerId);
}
/** The seat `n` places from `from` in the current direction of play. */
function seat(s, from, n = 1) {
	const len = s.players.length;
	return ((from + n * s.direction) % len + len) % len;
}
/**
* Whoever the clock is currently on: the player who owes a choice, else the
* player whose turn it is.
*/
function actorId(s) {
	if (s.phase !== "playing") return null;
	if (s.pending) return s.pending.playerId;
	return s.players[s.turn]?.id ?? null;
}
function startClock(s, ctx) {
	s.turnDeadline = s.rules.turnTimer > 0 ? ctx.now + s.rules.turnTimer * 1e3 : null;
	return s.turnDeadline;
}
/**
* Move play on by `seats` places. `seats === 2` means the player in between
* loses their turn, which is announced.
*/
function advance(s, seats, ctx, ev) {
	if (seats === 2 && s.players.length >= 2) ev.push({
		t: "skipped",
		playerId: s.players[seat(s, s.turn, 1)].id
	});
	s.turn = seat(s, s.turn, seats);
	startClock(s, ctx);
	ev.push({
		t: "turnStart",
		playerId: s.players[s.turn].id,
		deadline: s.turnDeadline
	});
}
/**
* Deck exhaustion: keep the top discard, shuffle everything under it back
* into the draw pile. If there is nothing to recycle the pile stays empty and
* players simply draw nothing.
*/
function reshuffleDiscard(s, ctx, ev) {
	if (s.discard.length <= 1) return;
	const top = s.discard[s.discard.length - 1];
	s.drawPile = shuffle(s.discard.slice(0, -1), ctx.rng);
	s.discard = [top];
	ev.push({
		t: "reshuffled",
		count: s.drawPile.length
	});
}
function drawOne(s, ctx, ev) {
	if (s.drawPile.length === 0) reshuffleDiscard(s, ctx, ev);
	return s.drawPile.pop() ?? null;
}
/** Deals up to `count` cards. Returns how many were actually available. */
function dealTo(s, index, count, ctx, ev) {
	let dealt = 0;
	for (let i = 0; i < count; i++) {
		const card = drawOne(s, ctx, ev);
		if (!card) break;
		s.players[index].hand.push(card);
		dealt++;
	}
	return dealt;
}
/** Does this hand hold a card of `color`, ignoring one card id? */
function holdsColor(hand, color, exceptId) {
	if (color === null) return false;
	return hand.some((c) => c.color === color && c.id !== exceptId);
}
/**
* May `card` be played by `player` right now, ignoring turn order?
*
* Wild Draw Four is the interesting one. The official restriction is that you
* may only play it holding no card of the active colour — but the challenge
* rule exists precisely so that players *can* break that restriction and risk
* being caught. So:
*
*   challenge ON  -> the play is allowed; a challenge adjudicates the bluff.
*   challenge OFF -> nothing would ever adjudicate it, so it is enforced here.
*/
function canPlay(s, player, card) {
	const top = topCard(s);
	if (!top) return false;
	if (card.kind === "wild4" && !s.rules.challenge) return !holdsColor(player.hand, s.activeColor, card.id);
	return matches(card, top, s.activeColor);
}
/** Callers own this draft; exported setup functions remain pure. */
function startRoundDraft(s, startIndex, ctx) {
	const round = s.phase === "lobby" ? 1 : s.round;
	const ev = [];
	s.phase = "playing";
	s.result = null;
	s.matchWinnerId = null;
	s.pending = null;
	s.drawStack = null;
	s.uno = null;
	s.lastPlayerId = null;
	s.direction = 1;
	s.passRecord = [];
	s.turn = (startIndex % s.players.length + s.players.length) % s.players.length;
	for (const p of s.players) {
		p.hand = [];
		p.roundPoints = 0;
		p.ready = false;
	}
	let deck = shuffle(createDeck(), ctx.rng);
	for (let round = 0; round < 7; round++) for (let i = 0; i < s.players.length; i++) {
		const index = (s.turn + i) % s.players.length;
		s.players[index].hand.push(deck.pop());
	}
	let top = deck.pop();
	while (top.kind === "wild4") {
		deck.push(top);
		deck = shuffle(deck, ctx.rng);
		top = deck.pop();
	}
	s.drawPile = deck;
	s.discard = [top];
	s.activeColor = top.color;
	s.round = round;
	ev.push({
		t: "roundStart",
		round: s.round,
		startingId: s.players[s.turn].id,
		topCard: top
	});
	switch (top.kind) {
		case "wild":
			s.pending = {
				kind: "color",
				playerId: s.players[s.turn].id,
				source: "initial",
				hadColorMatch: false,
				colorBefore: null,
				declaredUno: false
			};
			startClock(s, ctx);
			ev.push({
				t: "turnStart",
				playerId: s.players[s.turn].id,
				deadline: s.turnDeadline
			});
			break;
		case "skip":
			ev.push({
				t: "skipped",
				playerId: s.players[s.turn].id
			});
			advance(s, 1, ctx, ev);
			break;
		case "reverse":
			s.direction = -1;
			ev.push({
				t: "reversed",
				direction: s.direction
			});
			advance(s, 1, ctx, ev);
			break;
		case "draw2": {
			const victim = s.players[s.turn];
			const dealt = dealTo(s, s.turn, 2, ctx, ev);
			ev.push({
				t: "penalty",
				playerId: victim.id,
				count: dealt,
				reason: "drawStack"
			});
			ev.push({
				t: "skipped",
				playerId: victim.id
			});
			advance(s, 1, ctx, ev);
			break;
		}
		default:
			startClock(s, ctx);
			ev.push({
				t: "turnStart",
				playerId: s.players[s.turn].id,
				deadline: s.turnDeadline
			});
	}
	return {
		ok: true,
		state: s,
		events: ev
	};
}
/** Lobby -> first round. Resets match scores. */
function startMatch(state, ctx) {
	if (state.phase !== "lobby") return fail("already_started", "The game has already started.");
	if (state.players.length < 2) return fail("not_enough_players", "You need at least 2 players.");
	const base = clone(state);
	base.round = 1;
	for (const p of base.players) {
		p.score = 0;
		p.roundPoints = 0;
	}
	return startRoundDraft(base, 0, ctx);
}
/** Round over -> next round. The seat after the previous winner starts. */
function startNextRound(state, ctx) {
	if (state.phase !== "roundOver") return fail("not_between_rounds", "There is no round to advance from.");
	const base = clone(state);
	base.round = state.round + 1;
	const winner = state.result ? playerIndex(state, state.result.winnerId) : -1;
	return startRoundDraft(base, winner >= 0 ? (winner + 1) % base.players.length : 0, ctx);
}
function endRound(s, winnerIndex, ev) {
	const winner = s.players[winnerIndex];
	const hands = {};
	const points = {};
	const totals = {};
	let scored = 0;
	for (const p of s.players) {
		hands[p.id] = p.hand.slice();
		points[p.id] = handPoints(p.hand);
		p.roundPoints = 0;
		if (p.id !== winner.id) scored += points[p.id];
	}
	winner.score += scored;
	winner.roundPoints = scored;
	for (const p of s.players) totals[p.id] = p.score;
	const result = {
		winnerId: winner.id,
		points: scored,
		hands,
		handPoints: points,
		totals
	};
	s.result = result;
	s.pending = null;
	s.drawStack = null;
	s.uno = null;
	s.turnDeadline = null;
	for (const p of s.players) p.ready = false;
	ev.push({
		t: "roundOver",
		result
	});
	if (s.rules.matchMode === "single" || winner.score >= s.rules.targetScore) {
		s.phase = "matchOver";
		s.matchWinnerId = winner.id;
		ev.push({
			t: "matchOver",
			winnerId: winner.id
		});
	} else s.phase = "roundOver";
}
function applyIntent(state, playerId, intent, ctx) {
	if (state.phase !== "playing") return fail("not_playing", "The game is not running right now.");
	if (playerIndex(state, playerId) < 0) return fail("not_seated", "You are watching, not playing.");
	const s = clone(state);
	const ev = [];
	const problem = dispatch(s, playerId, intent, ctx, ev);
	if (problem) return problem;
	return {
		ok: true,
		state: s,
		events: ev
	};
}
function dispatch(s, playerId, intent, ctx, ev) {
	switch (intent.type) {
		case "PLAY_CARD": return handlePlay(s, playerId, intent.cardId, intent.declareUno === true, ctx, ev);
		case "DRAW": return handleDraw(s, playerId, ctx, ev);
		case "PASS": return handlePass(s, playerId, ctx, ev);
		case "CHOOSE_COLOR": return handleChooseColor(s, playerId, intent.color, ctx, ev);
		case "CHOOSE_PLAYER": return handleChoosePlayer(s, playerId, intent.playerId, ctx, ev);
		case "CALL_UNO": return handleCallUno(s, playerId, ctx, ev);
		case "CATCH_UNO": return handleCatchUno(s, playerId, intent.targetId, ctx, ev);
		case "CHALLENGE": return handleChallenge(s, playerId, ctx, ev);
	}
}
function handlePlay(s, playerId, cardId, declareUno, ctx, ev) {
	const index = playerIndex(s, playerId);
	const player = s.players[index];
	const card = player.hand.find((c) => c.id === cardId);
	if (!card) return fail("no_such_card", "That card is not in your hand.");
	const top = topCard(s);
	if (!top) return fail("no_discard", "There is nothing to play on.");
	if (s.pending) {
		if (s.pending.kind !== "drawn") return fail("resolve_first", "Finish the current choice first.");
		if (s.pending.playerId !== playerId) return fail("not_your_turn", "It is not your turn.");
		if (s.pending.cardId !== cardId) return fail("must_play_drawn", "You may only play the card you just drew.");
	}
	let jumpIn = false;
	if (index !== s.turn) {
		if (!s.rules.jumpIn) return fail("not_your_turn", "It is not your turn.");
		if (s.pending || s.drawStack) return fail("not_your_turn", "It is not your turn.");
		if (s.lastPlayerId === playerId) return fail("no_self_jump", "You cannot jump in on your own card.");
		if (isWild(top)) return fail("no_wild_jump", "You cannot jump in on a wild.");
		if (!sameFace(card, top)) return fail("not_exact_match", "Jumping in needs an exact match.");
		jumpIn = true;
	}
	if (s.drawStack) {
		if (!s.rules.stacking) return fail("must_draw", `You must draw ${s.drawStack.count}.`);
		if (card.kind !== s.drawStack.kind) return fail("cannot_stack", s.drawStack.kind === "draw2" ? "Only a Draw Two stacks here." : "Only a Wild Draw Four stacks here.");
	} else if (!canPlay(s, player, card)) return fail("illegal_card", "That card cannot be played right now.");
	if (jumpIn) s.turn = index;
	player.hand = player.hand.filter((c) => c.id !== cardId);
	s.discard.push(card);
	s.lastPlayerId = playerId;
	s.pending = null;
	ev.push({
		t: "played",
		playerId,
		card,
		jumpIn
	});
	return resolvePlay(s, index, card, declareUno, ctx, ev);
}
/**
* Applies the effect of a card that has just landed on the discard pile.
* Returns `null` on success — plays never fail this late.
*/
function resolvePlay(s, index, card, declaredUno, ctx, ev) {
	const player = s.players[index];
	const colorBefore = s.activeColor;
	if (card.color !== null) s.activeColor = card.color;
	if (player.hand.length === 0) {
		if (card.kind === "draw2" || card.kind === "wild4") {
			const victim = seat(s, index, 1);
			const dealt = dealTo(s, victim, card.kind === "draw2" ? 2 : 4, ctx, ev);
			ev.push({
				t: "penalty",
				playerId: s.players[victim].id,
				count: dealt,
				reason: "drawStack"
			});
		}
		endRound(s, index, ev);
		return null;
	}
	switch (card.kind) {
		case "number":
			if (s.rules.sevenZero && card.digit === 7) {
				if (s.players.length === 2) swapHands(s, index, seat(s, index, 1), ev);
				else {
					s.pending = {
						kind: "swap",
						playerId: player.id,
						declaredUno
					};
					return null;
				}
			} else if (s.rules.sevenZero && card.digit === 0) rotateHands(s, ev);
			concludeTurn(s, index, 1, declaredUno, ctx, ev);
			break;
		case "skip":
			concludeTurn(s, index, 2, declaredUno, ctx, ev);
			break;
		case "reverse":
			s.direction = s.direction === 1 ? -1 : 1;
			ev.push({
				t: "reversed",
				direction: s.direction
			});
			concludeTurn(s, index, s.players.length === 2 ? 2 : 1, declaredUno, ctx, ev);
			break;
		case "draw2":
			if (s.rules.stacking) {
				s.drawStack = {
					count: (s.drawStack?.count ?? 0) + 2,
					kind: "draw2",
					playedBy: player.id,
					challengeable: false,
					hadColorMatch: false,
					colorBefore: null
				};
				concludeTurn(s, index, 1, declaredUno, ctx, ev);
			} else {
				const victim = seat(s, index, 1);
				const dealt = dealTo(s, victim, 2, ctx, ev);
				ev.push({
					t: "penalty",
					playerId: s.players[victim].id,
					count: dealt,
					reason: "drawStack"
				});
				concludeTurn(s, index, 2, declaredUno, ctx, ev);
			}
			break;
		case "wild":
		case "wild4":
			s.pending = {
				kind: "color",
				playerId: player.id,
				source: card.kind,
				hadColorMatch: card.kind === "wild4" ? holdsColor(player.hand, colorBefore) : false,
				colorBefore,
				declaredUno
			};
			return null;
	}
	return null;
}
/** Opens the UNO window if needed, then moves play on. */
function concludeTurn(s, index, seats, declaredUno, ctx, ev) {
	const player = s.players[index];
	if (player.hand.length === 1) {
		s.uno = {
			playerId: player.id,
			deadline: ctx.now + UNO_WINDOW_MS,
			called: declaredUno,
			accusers: []
		};
		if (declaredUno) ev.push({
			t: "unoCalled",
			playerId: player.id
		});
	}
	advance(s, seats, ctx, ev);
}
function swapHands(s, a, b, ev) {
	const tmp = s.players[a].hand;
	s.players[a].hand = s.players[b].hand;
	s.players[b].hand = tmp;
	ev.push({
		t: "handsSwapped",
		aId: s.players[a].id,
		bId: s.players[b].id
	});
}
/** Every hand moves one seat in the current direction of play. */
function rotateHands(s, ev) {
	const hands = s.players.map((p) => p.hand);
	const len = s.players.length;
	for (let i = 0; i < len; i++) {
		const target = ((i + s.direction) % len + len) % len;
		s.players[target].hand = hands[i];
	}
	ev.push({
		t: "handsRotated",
		direction: s.direction
	});
}
function handleChooseColor(s, playerId, color, ctx, ev) {
	const pending = s.pending;
	if (!pending || pending.kind !== "color") return fail("nothing_to_choose", "No colour is waiting to be chosen.");
	if (pending.playerId !== playerId) return fail("not_your_choice", "That is not your choice to make.");
	if (!COLORS.includes(color)) return fail("bad_color", "That is not a colour.");
	const { source, hadColorMatch, colorBefore, declaredUno } = pending;
	const index = playerIndex(s, playerId);
	s.activeColor = color;
	s.pending = null;
	ev.push({
		t: "colorChosen",
		playerId,
		color
	});
	if (source === "initial") {
		startClock(s, ctx);
		ev.push({
			t: "turnStart",
			playerId,
			deadline: s.turnDeadline
		});
		return null;
	}
	if (source === "wild") {
		concludeTurn(s, index, 1, declaredUno, ctx, ev);
		return null;
	}
	if (s.rules.challenge || s.rules.stacking) {
		const existing = s.drawStack;
		s.drawStack = {
			count: (existing?.count ?? 0) + 4,
			kind: "wild4",
			playedBy: playerId,
			challengeable: s.rules.challenge && existing === null,
			hadColorMatch,
			colorBefore
		};
		concludeTurn(s, index, 1, declaredUno, ctx, ev);
	} else {
		const victim = seat(s, index, 1);
		const dealt = dealTo(s, victim, 4, ctx, ev);
		ev.push({
			t: "penalty",
			playerId: s.players[victim].id,
			count: dealt,
			reason: "drawStack"
		});
		concludeTurn(s, index, 2, declaredUno, ctx, ev);
	}
	return null;
}
function handleChoosePlayer(s, playerId, targetId, ctx, ev) {
	const pending = s.pending;
	if (!pending || pending.kind !== "swap") return fail("nothing_to_choose", "No swap is waiting.");
	if (pending.playerId !== playerId) return fail("not_your_choice", "That is not your choice to make.");
	if (targetId === playerId) return fail("bad_target", "Pick somebody else.");
	const target = playerIndex(s, targetId);
	if (target < 0) return fail("bad_target", "That player is not at the table.");
	const index = playerIndex(s, playerId);
	s.pending = null;
	swapHands(s, index, target, ev);
	concludeTurn(s, index, 1, pending.declaredUno, ctx, ev);
	return null;
}
function handleDraw(s, playerId, ctx, ev) {
	const index = playerIndex(s, playerId);
	if (s.pending) {
		if (s.pending.kind === "drawn" && s.pending.playerId === playerId) return fail("already_drew", "Play the card you drew, or pass.");
		return fail("resolve_first", "Finish the current choice first.");
	}
	if (index !== s.turn) return fail("not_your_turn", "It is not your turn.");
	if (s.drawStack) {
		const owed = s.drawStack.count;
		const dealt = dealTo(s, index, owed, ctx, ev);
		s.drawStack = null;
		ev.push({
			t: "penalty",
			playerId,
			count: dealt,
			reason: "drawStack"
		});
		advance(s, 1, ctx, ev);
		return null;
	}
	if (s.activeColor && !s.passRecord.some((record) => record.playerId === playerId && record.color === s.activeColor)) s.passRecord.push({
		playerId,
		color: s.activeColor
	});
	const player = s.players[index];
	const limit = s.rules.drawToMatch ? 108 : 1;
	let drawn = 0;
	let last = null;
	while (drawn < limit) {
		const card = drawOne(s, ctx, ev);
		if (!card) break;
		player.hand.push(card);
		last = card;
		drawn++;
		if (canPlay(s, player, card)) break;
	}
	if (drawn > 0) ev.push({
		t: "drew",
		playerId,
		count: drawn
	});
	if (last && canPlay(s, player, last)) {
		s.pending = {
			kind: "drawn",
			playerId,
			cardId: last.id
		};
		return null;
	}
	advance(s, 1, ctx, ev);
	return null;
}
function handlePass(s, playerId, ctx, ev) {
	if (!s.pending || s.pending.kind !== "drawn" || s.pending.playerId !== playerId) return fail("nothing_to_pass", "You have nothing to pass on.");
	s.pending = null;
	advance(s, 1, ctx, ev);
	return null;
}
function handleCallUno(s, playerId, ctx, ev) {
	if (!s.uno || s.uno.playerId !== playerId) return fail("no_uno_window", "You are not on one card.");
	if (ctx.now > s.uno.deadline) return fail("window_closed", "Too late.");
	if (s.uno.called) return fail("already_called", "You already called it.");
	s.uno.called = true;
	ev.push({
		t: "unoCalled",
		playerId
	});
	return null;
}
/**
* The catch race. The Durable Object is single-threaded, so whichever message
* lands first is simply the one that runs first — no locking needed.
*/
function handleCatchUno(s, playerId, targetId, ctx, ev) {
	if (!s.uno) return fail("nothing_to_catch", "Nobody is on one card.");
	if (s.uno.playerId !== targetId) return fail("nothing_to_catch", "They are not the one on one card.");
	if (playerId === targetId) return fail("nothing_to_catch", "You cannot catch yourself.");
	if (ctx.now > s.uno.deadline) return fail("window_closed", "The moment has passed.");
	if (s.uno.accusers.includes(playerId)) return fail("already_accused", "You already called them out.");
	s.uno.accusers.push(playerId);
	const accuser = playerIndex(s, playerId);
	if (s.uno.called) {
		const dealt = dealTo(s, accuser, 2, ctx, ev);
		ev.push({
			t: "falseAccusation",
			byId: playerId,
			targetId,
			penalty: dealt
		});
		ev.push({
			t: "penalty",
			playerId,
			count: dealt,
			reason: "falseAccusation"
		});
		return null;
	}
	const dealt = dealTo(s, playerIndex(s, targetId), 2, ctx, ev);
	ev.push({
		t: "unoCaught",
		byId: playerId,
		targetId,
		penalty: dealt
	});
	ev.push({
		t: "penalty",
		playerId: targetId,
		count: dealt,
		reason: "unoCaught"
	});
	s.uno = null;
	return null;
}
function handleChallenge(s, playerId, ctx, ev) {
	const stack = s.drawStack;
	if (!stack || !stack.challengeable) return fail("nothing_to_challenge", "There is nothing to challenge.");
	if (s.pending) return fail("resolve_first", "Finish the current choice first.");
	const index = playerIndex(s, playerId);
	if (index !== s.turn) return fail("not_your_turn", "Only the player facing it may challenge.");
	const targetIndex = playerIndex(s, stack.playedBy);
	const target = s.players[targetIndex];
	ev.push({
		t: "handRevealed",
		playerId: target.id,
		hand: target.hand.slice(),
		to: playerId
	});
	const owed = stack.count;
	s.drawStack = null;
	if (stack.hadColorMatch) {
		const dealt = dealTo(s, targetIndex, owed, ctx, ev);
		ev.push({
			t: "challenged",
			challengerId: playerId,
			targetId: target.id,
			success: true,
			penalty: dealt
		});
		ev.push({
			t: "penalty",
			playerId: target.id,
			count: dealt,
			reason: "challengeWon"
		});
		startClock(s, ctx);
		ev.push({
			t: "turnStart",
			playerId,
			deadline: s.turnDeadline
		});
	} else {
		const dealt = dealTo(s, index, owed + 2, ctx, ev);
		ev.push({
			t: "challenged",
			challengerId: playerId,
			targetId: target.id,
			success: false,
			penalty: dealt
		});
		ev.push({
			t: "penalty",
			playerId,
			count: dealt,
			reason: "challengeLost"
		});
		advance(s, 1, ctx, ev);
	}
	return null;
}
/** Closes an expired UNO window. Safe to call speculatively. */
function expireUnoWindow(state, ctx) {
	if (!state.uno) return fail("no_uno_window", "No window is open.");
	if (state.uno.deadline > ctx.now) return fail("too_early", "The window is still open.");
	const s = clone(state);
	const ev = [];
	const window = s.uno;
	if (!window.called) ev.push({
		t: "unoMissed",
		playerId: window.playerId
	});
	ev.push({
		t: "unoWindowClosed",
		playerId: window.playerId
	});
	s.uno = null;
	return {
		ok: true,
		state: s,
		events: ev
	};
}
/**
* The turn clock ran out: draw and pass on the player's behalf. Any choice
* they owed is resolved with a sensible default first.
*/
function timeoutTurn(state, ctx) {
	if (state.phase !== "playing") return fail("not_playing", "The game is not running.");
	const actor = actorId(state);
	if (!actor) return fail("no_actor", "Nobody is on the clock.");
	let s = state;
	const events = [{
		t: "timedOut",
		playerId: actor
	}];
	const run = (intent, from = actor) => {
		const result = applyIntent(s, from, intent, ctx);
		if (!result.ok) return false;
		s = result.state;
		events.push(...result.events);
		return true;
	};
	const pending = s.pending;
	if (pending?.kind === "color") run({
		type: "CHOOSE_COLOR",
		color: bestColorFor(s, actor, ctx)
	});
	else if (pending?.kind === "swap") {
		const target = fewestCardsOpponent(s, actor);
		if (target) run({
			type: "CHOOSE_PLAYER",
			playerId: target
		});
	} else if (pending?.kind === "drawn") {
		run({ type: "PASS" });
		return {
			ok: true,
			state: s,
			events
		};
	}
	if (actorId(s) === actor && s.phase === "playing") {
		if (run({ type: "DRAW" }) && s.pending?.kind === "drawn" && s.pending.playerId === actor) run({ type: "PASS" });
	}
	return {
		ok: true,
		state: s,
		events
	};
}
/** The colour a player holds most of — used for auto-choices and by bots. */
function bestColorFor(s, playerId, ctx) {
	const player = findPlayer(s, playerId);
	const counts = /* @__PURE__ */ new Map();
	for (const color of COLORS) counts.set(color, 0);
	for (const card of player?.hand ?? []) if (card.color) counts.set(card.color, (counts.get(card.color) ?? 0) + 1);
	let best = null;
	let bestCount = -1;
	for (const color of COLORS) {
		const count = counts.get(color) ?? 0;
		if (count > bestCount) {
			best = color;
			bestCount = count;
		}
	}
	if (bestCount === 0) return COLORS[ctx.rng.int(COLORS.length)];
	return best;
}
function fewestCardsOpponent(s, playerId) {
	let best = null;
	for (const p of s.players) {
		if (p.id === playerId) continue;
		if (!best || p.hand.length < best.hand.length) best = p;
	}
	return best?.id ?? null;
}
/**
* What `viewerId` is allowed to know. Every broadcast goes through here:
* a player gets their own hand in full and nothing but a count for everyone
* else, and the draw pile is never sent at all.
*
* Pass `null` for spectators.
*/
function serializeFor(s, viewerId, now) {
	const players = s.players.map((p) => {
		const view = {
			id: p.id,
			name: p.name,
			avatar: p.avatar,
			isBot: p.isBot,
			botLevel: p.botLevel,
			connected: p.connected,
			ready: p.ready,
			handCount: p.hand.length,
			score: p.score,
			roundPoints: p.roundPoints,
			botControlled: p.botControlled
		};
		if (p.id === viewerId) view.hand = p.hand.slice();
		return view;
	});
	let pending = null;
	if (s.pending) {
		if (s.pending.kind === "color") pending = {
			kind: "color",
			playerId: s.pending.playerId,
			source: s.pending.source
		};
		else if (s.pending.kind === "swap") pending = {
			kind: "swap",
			playerId: s.pending.playerId
		};
		else pending = {
			kind: "drawn",
			playerId: s.pending.playerId,
			cardId: s.pending.playerId === viewerId ? s.pending.cardId : void 0
		};
	}
	const drawStack = s.drawStack ? {
		count: s.drawStack.count,
		kind: s.drawStack.kind,
		playedBy: s.drawStack.playedBy,
		challengeable: s.drawStack.challengeable
	} : null;
	return {
		code: s.code,
		phase: s.phase,
		rules: s.rules,
		hostId: s.hostId,
		players,
		turn: s.turn,
		direction: s.direction,
		drawCount: s.drawPile.length,
		discardTop: topCard(s),
		discardCount: s.discard.length,
		activeColor: s.activeColor,
		pending,
		drawStack,
		uno: s.uno ? {
			...s.uno,
			accusers: s.uno.accusers.slice()
		} : null,
		round: s.round,
		turnDeadline: s.turnDeadline,
		result: s.result,
		matchWinnerId: s.matchWinnerId,
		youId: viewerId,
		moves: viewerId ? legalMoves(s, viewerId) : NO_MOVES,
		now
	};
}
/**
* Everything `playerId` may legally do at this instant. The client renders
* straight off this, so playable/dimmed cards can never disagree with what
* the server will accept.
*/
function legalMoves(s, playerId) {
	const index = playerIndex(s, playerId);
	if (index < 0 || s.phase !== "playing") return { ...NO_MOVES };
	const player = s.players[index];
	const top = topCard(s);
	const moves = {
		...NO_MOVES,
		playable: [],
		jumpIn: []
	};
	const owesChoice = s.pending !== null && s.pending.playerId === playerId;
	const isTurn = index === s.turn;
	if (s.pending?.kind === "drawn" && s.pending.playerId === playerId) {
		const drawnId = s.pending.cardId;
		const drawn = player.hand.find((c) => c.id === drawnId);
		if (drawn && canPlay(s, player, drawn)) moves.playable = [drawn.id];
		moves.canPass = true;
	} else if (s.pending?.kind === "color" && owesChoice) moves.mustChooseColor = true;
	else if (s.pending?.kind === "swap" && owesChoice) moves.mustChooseSwapTarget = true;
	else if (!s.pending && isTurn) {
		if (s.drawStack) {
			const stackKind = s.drawStack.kind;
			if (s.rules.stacking) moves.playable = player.hand.filter((c) => c.kind === stackKind).map((c) => c.id);
			moves.canChallenge = s.drawStack.challengeable;
		} else moves.playable = player.hand.filter((c) => canPlay(s, player, c)).map((c) => c.id);
		moves.canDraw = true;
	}
	if (s.rules.jumpIn && !s.pending && !s.drawStack && top && !isWild(top) && !isTurn && s.lastPlayerId !== playerId) moves.jumpIn = player.hand.filter((c) => sameFace(c, top)).map((c) => c.id);
	if (s.uno) {
		if (s.uno.playerId === playerId) moves.canCallUno = !s.uno.called;
		else if (!s.uno.called && !s.uno.accusers.includes(playerId)) moves.catchTargetId = s.uno.playerId;
	}
	return moves;
}
//#endregion
//#region shared/room.ts
/** No 0/O or 1/I — room codes get read out loud. */
var CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function makeRoomCode(rng) {
	let code = "";
	for (let i = 0; i < 6; i++) code += CODE_ALPHABET[rng.int(32)];
	return code;
}
/** Accepts lower case and trims, then validates against the alphabet. */
function normalizeRoomCode(input) {
	const code = input.trim().toUpperCase();
	if (code.length !== 6) return null;
	for (const ch of code) if (!"ABCDEFGHJKLMNPQRSTUVWXYZ23456789".includes(ch)) return null;
	return code;
}
var NAME_ADJECTIVES = [
	"Sneaky",
	"Reckless",
	"Polite",
	"Feral",
	"Smug",
	"Doomed",
	"Lucky",
	"Grumpy",
	"Velvet",
	"Turbo",
	"Midnight",
	"Cosmic",
	"Silent",
	"Nuclear",
	"Wobbly",
	"Regal"
];
var NAME_NOUNS = [
	"Pigeon",
	"Wizard",
	"Goblin",
	"Otter",
	"Bandit",
	"Muffin",
	"Comet",
	"Raccoon",
	"Noodle",
	"Tornado",
	"Walrus",
	"Phantom",
	"Cactus",
	"Badger",
	"Gremlin",
	"Marmot"
];
function randomNickname(rng) {
	return `${NAME_ADJECTIVES[rng.int(NAME_ADJECTIVES.length)]} ${NAME_NOUNS[rng.int(NAME_NOUNS.length)]}`;
}
var BOT_NAMES = [
	"Mary",
	"Brian",
	"Lucas",
	"Saffron",
	"Boo",
	"Molly",
	"Zoe",
	"Oliver"
];
function createRoomState(code, rules = {}) {
	return {
		code,
		phase: "lobby",
		rules: {
			...DEFAULT_RULES,
			...rules
		},
		hostId: null,
		players: [],
		turn: 0,
		direction: 1,
		drawPile: [],
		discard: [],
		activeColor: null,
		pending: null,
		drawStack: null,
		uno: null,
		lastPlayerId: null,
		round: 0,
		turnDeadline: null,
		result: null,
		matchWinnerId: null,
		passRecord: []
	};
}
/** Trims, caps length, strips control characters, falls back to a default. */
function cleanName(input, fallback) {
	const cleaned = Array.from(input.trim()).filter((ch) => ch >= " " && ch !== "").join("").slice(0, 16).trim();
	return cleaned.length > 0 ? cleaned : fallback;
}
/** Makes `name` unique at the table by appending a number if it collides. */
function uniqueName(state, name) {
	const taken = new Set(state.players.map((p) => p.name.toLowerCase()));
	if (!taken.has(name.toLowerCase())) return name;
	for (let n = 2; n < 100; n++) {
		const candidate = `${name} ${n}`;
		if (!taken.has(candidate.toLowerCase())) return candidate;
	}
	return name;
}
function newPlayer(seat) {
	return {
		id: seat.id,
		name: seat.name,
		avatar: (seat.avatar % 12 + 12) % 12,
		isBot: seat.isBot === true,
		botLevel: seat.botLevel ?? "normal",
		connected: true,
		ready: false,
		hand: [],
		score: 0,
		roundPoints: 0,
		botControlled: false
	};
}
/** Seats a player. Mutates — callers own a draft. */
function seatPlayer(state, seat) {
	const player = newPlayer({
		...seat,
		name: uniqueName(state, seat.name)
	});
	state.players.push(player);
	if (!state.hostId) state.hostId = player.id;
	return player;
}
/** Picks an unused bot name and avatar. */
function makeBot(state, level, rng) {
	const used = new Set(state.players.map((p) => p.name));
	const available = BOT_NAMES.filter((n) => !used.has(n));
	const pool = available.length > 0 ? available : BOT_NAMES;
	const name = pool[rng.int(pool.length)];
	const takenAvatars = new Set(state.players.map((p) => p.avatar));
	let avatar = rng.int(9);
	for (let i = 0; i < 9 && takenAvatars.has(avatar); i++) avatar = (avatar + 1) % 9;
	return {
		id: `bot-${name.toLowerCase()}-${state.players.length}`,
		name,
		avatar,
		isBot: true,
		botLevel: level
	};
}
/**
* Removes a seat and keeps the table coherent: the host moves on, and the
* turn index stays pointed at the same player it was pointed at before.
*/
function unseatPlayer(state, playerId) {
	const index = state.players.findIndex((p) => p.id === playerId);
	if (index < 0) return false;
	const wasTurn = state.turn;
	state.players.splice(index, 1);
	if (state.players.length === 0) {
		state.hostId = null;
		state.turn = 0;
		return true;
	}
	if (state.hostId === playerId) state.hostId = (state.players.find((p) => !p.isBot) ?? state.players[0]).id;
	if (index < wasTurn) state.turn = wasTurn - 1;
	state.turn = state.turn % state.players.length;
	return true;
}
var TURN_TIMERS = [
	0,
	15,
	30,
	60
];
/** Validates and applies a host's rule change. Unknown keys are ignored. */
function applyRuleChange(rules, patch) {
	const next = { ...rules };
	if (typeof patch.challenge === "boolean") next.challenge = patch.challenge;
	if (typeof patch.stacking === "boolean") next.stacking = patch.stacking;
	if (typeof patch.jumpIn === "boolean") next.jumpIn = patch.jumpIn;
	if (typeof patch.sevenZero === "boolean") next.sevenZero = patch.sevenZero;
	if (typeof patch.drawToMatch === "boolean") next.drawToMatch = patch.drawToMatch;
	if (patch.turnTimer !== void 0 && TURN_TIMERS.includes(patch.turnTimer)) next.turnTimer = patch.turnTimer;
	if (patch.matchMode === "single" || patch.matchMode === "match") next.matchMode = patch.matchMode;
	if (typeof patch.targetScore === "number" && Number.isFinite(patch.targetScore)) next.targetScore = Math.min(2e3, Math.max(100, Math.round(patch.targetScore)));
	return next;
}
/** Everyone seated is ready and there are enough of them. */
function canStart(state) {
	return state.phase === "lobby" && state.players.length >= 2 && state.players.every((p) => p.isBot || p.ready);
}
//#endregion
//#region shared/protocol.ts
/** The six-emote quick bar. */
var EMOTES = [
	{
		glyph: "👋",
		label: "Hello"
	},
	{
		glyph: "😂",
		label: "Laughing"
	},
	{
		glyph: "😱",
		label: "Shocked"
	},
	{
		glyph: "🔥",
		label: "Nice one"
	},
	{
		glyph: "🤔",
		label: "Thinking"
	},
	{
		glyph: "🎉",
		label: "Celebrate"
	}
];
var CLOSE_BAD_ROOM = 4002;
var CLOSE_REPLACED = 4003;
/** How long a dropped player keeps their seat before a bot takes over. */
var RECONNECT_GRACE_MS = 6e4;
/** How long an empty room lives before it deletes itself. */
var ROOM_TTL_MS = 6e5;
/** Bot "thinking" delay bounds. */
var BOT_MIN_DELAY_MS = 1e3;
var BOT_MAX_DELAY_MS = 2500;
//#endregion
//#region shared/rng.ts
/** Request-independent crypto words, refilled lazily in bounded batches. */
var randomWords = /* @__PURE__ */ new Uint32Array(256);
var randomOffset = randomWords.length;
/**
* Rejection sampling on top of `crypto.getRandomValues` — taking a plain
* modulo would bias the low values.
*/
var cryptoRng = { int(max) {
	if (max <= 1) return 0;
	const limit = Math.floor(4294967296 / max) * max;
	let value;
	do {
		if (randomOffset === randomWords.length) {
			crypto.getRandomValues(randomWords);
			randomOffset = 0;
		}
		value = randomWords[randomOffset++];
	} while (value >= limit);
	return value % max;
} };
/** Random integer in `[min, max]`, inclusive. */
function randomBetween(min, max, rng) {
	return min + rng.int(max - min + 1);
}
//#endregion
//#region shared/bots.ts
/** Builds the (deliberately limited) view a bot plays from. */
function botView(state, botId, now) {
	return {
		room: serializeFor(state, botId, now),
		discard: state.discard.slice(),
		passRecord: state.passRecord.slice()
	};
}
/** How long the bot should appear to think about it. */
function botDelay(rng) {
	return randomBetween(BOT_MIN_DELAY_MS, BOT_MAX_DELAY_MS, rng);
}
function seatAt(room, from, step) {
	const len = room.players.length;
	return ((from + step * room.direction) % len + len) % len;
}
function buildContext(view) {
	const room = view.room;
	const index = room.players.findIndex((p) => p.id === room.youId);
	if (index < 0) return null;
	const me = room.players[index];
	const hand = me.hand ?? [];
	const opponents = room.players.filter((p) => p.id !== me.id);
	const next = room.players.length > 1 ? room.players[seatAt(room, index, 1)] : null;
	const previous = room.players.length > 1 ? room.players[seatAt(room, index, -1)] : null;
	const colorCounts = {
		red: 0,
		yellow: 0,
		green: 0,
		blue: 0
	};
	for (const card of hand) if (card.color) colorCounts[card.color]++;
	let bestColor = COLORS[0];
	for (const color of COLORS) if (colorCounts[color] > colorCounts[bestColor]) bestColor = color;
	return {
		view,
		level: me.botLevel,
		me,
		hand,
		opponents,
		next,
		previous,
		nextThreat: next !== null && next.handCount <= 2,
		previousThreat: previous !== null && previous.handCount <= 2,
		anyThreat: opponents.some((p) => p.handCount <= 2),
		colorCounts,
		bestColor
	};
}
/**
* The bot's move for the current state, or `null` if it has nothing to do
* (not its turn, or the game is not running).
*/
function decideBotIntent(view, rng) {
	const ctx = buildContext(view);
	if (!ctx) return null;
	const { room } = view;
	const moves = room.moves;
	if (room.phase !== "playing") return null;
	if (moves.mustChooseColor) return {
		type: "CHOOSE_COLOR",
		color: chooseColor(ctx, rng)
	};
	if (moves.mustChooseSwapTarget) {
		const target = ctx.opponents.reduce((best, p) => best === null || p.handCount < best.handCount ? p : best, null);
		if (target) return {
			type: "CHOOSE_PLAYER",
			playerId: target.id
		};
	}
	if (moves.canChallenge && shouldChallenge(ctx, rng)) return { type: "CHALLENGE" };
	if (moves.playable.length > 0) {
		const playable = ctx.hand.filter((c) => moves.playable.includes(c.id));
		if (playable.length > 0) return {
			type: "PLAY_CARD",
			cardId: bestCard(ctx, playable, rng).id,
			declareUno: ctx.hand.length === 2
		};
	}
	if (moves.canPass) return { type: "PASS" };
	if (moves.canDraw) return { type: "DRAW" };
	return null;
}
/**
* Should this bot pounce on an open UNO window? Easy bots never notice.
* The DO calls this on a short alarm so a human always has a fair shot first.
*/
function decideBotCatch(view) {
	const ctx = buildContext(view);
	if (!ctx) return null;
	if (ctx.level === "easy") return null;
	const uno = view.room.uno;
	const target = view.room.moves.catchTargetId;
	if (!uno || !target) return null;
	if (uno.called) return null;
	return {
		type: "CATCH_UNO",
		targetId: target
	};
}
function bestCard(ctx, playable, rng) {
	if (ctx.level === "easy") return playable[rng.int(playable.length)];
	let best = playable[0];
	let bestScore = -Infinity;
	for (const card of playable) {
		const score = scoreCard(ctx, card) + rng.int(3);
		if (score > bestScore) {
			best = card;
			bestScore = score;
		}
	}
	return best;
}
function scoreCard(ctx, card) {
	const twoPlayer = ctx.view.room.players.length === 2;
	let score;
	switch (card.kind) {
		case "draw2":
			score = ctx.nextThreat ? 80 : 28;
			break;
		case "skip":
			score = ctx.nextThreat ? 74 : 24;
			break;
		case "reverse":
			score = twoPlayer ? ctx.nextThreat ? 70 : 22 : ctx.previousThreat ? -6 : 14;
			break;
		case "number":
			score = 10 + (card.digit ?? 0) * .6;
			break;
		case "wild":
			score = -40;
			break;
		case "wild4": return scoreWildFour(ctx);
	}
	if (card.color !== null && card.color === ctx.bestColor) score += 6;
	if (ctx.level === "hard") {
		if (ctx.anyThreat) score += cardPoints(card) * .8;
		if (card.color !== null && hasPassedOn(ctx, ctx.next?.id, card.color)) score += 15;
	}
	return score;
}
/** Hard bots time the Wild Draw Four; everyone else just sits on it. */
function scoreWildFour(ctx) {
	if (ctx.level !== "hard") return -60;
	const activeColor = ctx.view.room.activeColor;
	if (activeColor === null || !ctx.hand.some((c) => c.color === activeColor)) return ctx.nextThreat ? 85 : -8;
	if (!ctx.view.room.rules.challenge) return ctx.nextThreat ? 60 : -20;
	return ctx.hand.length <= 2 ? 5 : -85;
}
function hasPassedOn(ctx, playerId, color) {
	if (!playerId) return false;
	return ctx.view.passRecord.some((r) => r.playerId === playerId && r.color === color);
}
function chooseColor(ctx, rng) {
	if (ctx.level === "easy") {
		const colored = ctx.hand.filter((c) => c.color !== null);
		if (colored.length === 0) return COLORS[rng.int(COLORS.length)];
		return colored[rng.int(colored.length)].color;
	}
	let best = ctx.bestColor;
	let bestScore = -Infinity;
	for (const color of COLORS) {
		let score = ctx.colorCounts[color] * 10;
		if (ctx.level === "hard") {
			if (hasPassedOn(ctx, ctx.next?.id, color)) score += 14;
			score -= countDiscarded(ctx, color) * .4;
		}
		score += rng.int(2);
		if (score > bestScore) {
			best = color;
			bestScore = score;
		}
	}
	return best;
}
function countDiscarded(ctx, color) {
	let count = 0;
	for (const card of ctx.view.discard) if (card.color === color) count++;
	return count;
}
/**
* Bots challenge on public evidence only. They cannot see whether the play
* was a bluff — nobody at the table can.
*/
function shouldChallenge(ctx, rng) {
	const stack = ctx.view.room.drawStack;
	if (!stack) return false;
	if (ctx.level === "easy") return false;
	if (ctx.level === "normal") return rng.int(100) < 20;
	const target = ctx.opponents.find((p) => p.id === stack.playedBy);
	if (!target) return false;
	const beneath = ctx.view.discard[ctx.view.discard.length - 2];
	const previousColor = beneath && !isWild(beneath) ? beneath.color : null;
	if (previousColor && hasPassedOn(ctx, target.id, previousColor)) return false;
	if (ctx.hand.length >= 12) return false;
	return rng.int(100) < (target.handCount >= 5 ? 45 : 15);
}
//#endregion
//#region shared/narrate.ts
/** Returns `null` for events that do not deserve a line in the log. */
function describeEvent(event, nameOf) {
	switch (event.t) {
		case "roundStart": return `Round ${event.round} — ${nameOf(event.startingId)} starts on ${cardLabel(event.topCard)}.`;
		case "played": return event.jumpIn ? `${nameOf(event.playerId)} jumped in with ${cardLabel(event.card)}.` : `${nameOf(event.playerId)} played ${cardLabel(event.card)}.`;
		case "drew": return event.count === 1 ? `${nameOf(event.playerId)} drew a card.` : `${nameOf(event.playerId)} drew ${event.count} cards.`;
		case "colorChosen": return `${nameOf(event.playerId)} chose ${colorLabel(event.color)}.`;
		case "skipped": return `${nameOf(event.playerId)} was skipped.`;
		case "reversed": return "Direction reversed.";
		case "reshuffled": return `Deck ran out — ${event.count} cards reshuffled.`;
		case "unoCalled": return `${nameOf(event.playerId)} called UNO!`;
		case "unoCaught": return `${nameOf(event.byId)} caught ${nameOf(event.targetId)} — ${event.penalty} cards.`;
		case "unoMissed": return `${nameOf(event.playerId)} never called UNO, and got away with it.`;
		case "falseAccusation": return `${nameOf(event.byId)} was too slow to catch ${nameOf(event.targetId)} — ${event.penalty} cards.`;
		case "challenged": return event.success ? `${nameOf(event.challengerId)} challenged ${nameOf(event.targetId)} and won — ${event.penalty} cards to ${nameOf(event.targetId)}.` : `${nameOf(event.challengerId)} challenged ${nameOf(event.targetId)} and lost — ${event.penalty} cards.`;
		case "handsSwapped": return `${nameOf(event.aId)} swapped hands with ${nameOf(event.bId)}.`;
		case "handsRotated": return "Everyone passed their hand along.";
		case "penalty": return event.reason === "drawStack" && event.count > 0 ? `${nameOf(event.playerId)} drew ${event.count}.` : null;
		case "timedOut": return `${nameOf(event.playerId)} ran out of time.`;
		case "roundOver": return `${nameOf(event.result.winnerId)} went out and scored ${event.result.points}.`;
		case "matchOver": return `${nameOf(event.winnerId)} wins the match!`;
		case "playerJoined": return `${event.name} joined.`;
		case "playerLeft": return `${event.name} left.`;
		case "playerReconnected": return `${event.name} reconnected.`;
		case "botTookOver": return `A bot is playing ${event.name}'s seat.`;
		case "turnStart":
		case "unoWindowClosed":
		case "handRevealed": return null;
	}
}
//#endregion
//#region worker/room.ts
/**
* The Room Durable Object — one instance per room code, and the single
* authority on the game.
*
* It owns the deck, the shuffle, every hand and the turn order. Clients send
* intents; nothing they send is trusted for legality, turn order or
* randomness. Every outbound frame is built by `serializeFor`, so a player is
* only ever sent their own hand.
*
* Sockets use the WebSocket Hibernation API, so a room full of people
* thinking about their next move costs nothing. Because hibernation discards
* in-memory state and JavaScript timers, identity rides along on each socket
* as a serialized attachment, and every deadline in the game is a single
* Durable Object alarm set to the nearest one.
*/
/** Bots pounce a beat after a window opens, so a human always gets first go. */
var BOT_CATCH_MIN_MS = 900;
var BOT_CATCH_MAX_MS = 2e3;
/** Flood guard, per player, per window. */
var RATE_WINDOW_MS = 3e3;
var RATE_LIMIT = 40;
/** Control characters, which have no business in a nickname or a chat line. */
var CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;
var Room = class extends DurableObject {
	/** `null` until somebody creates this room, and again once it is cleaned up. */
	room = null;
	chat = [];
	/** Reconnection tokens. Never serialized to a client other than its owner. */
	tokens = {};
	timers = [];
	/** The alarm as last written: `undefined` until known, `null` for none. */
	alarmAt = void 0;
	/** In-memory only: resets on hibernation, which is fine for a flood guard. */
	rates = /* @__PURE__ */ new Map();
	constructor(ctx, env) {
		super(ctx, env);
		ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(JSON.stringify({ t: "ping" }), JSON.stringify({
			t: "pong",
			now: 0
		})));
		ctx.blockConcurrencyWhile(async () => {
			const stored = await ctx.storage.get("room");
			if (!stored) return;
			this.room = stored.room;
			this.chat = stored.chat ?? [];
			this.tokens = stored.tokens ?? {};
			this.timers = stored.timers ?? [];
		});
	}
	/** Reserves this room code. Returns false if it is already taken. */
	async createIfAbsent(code, rules) {
		if (this.room) return false;
		this.room = createRoomState(code, rules);
		this.schedule(Date.now());
		await this.persist();
		await this.armAlarm();
		return true;
	}
	/** Enough for the client to say something friendly before connecting. */
	async info() {
		if (!this.room) return {
			exists: false,
			phase: null,
			players: 0,
			seatsFree: 0,
			started: false
		};
		return {
			exists: true,
			phase: this.room.phase,
			players: this.room.players.length,
			seatsFree: Math.max(0, 8 - this.room.players.length),
			started: this.room.phase !== "lobby"
		};
	}
	async fetch(request) {
		if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return new Response("Expected a WebSocket upgrade.", { status: 426 });
		const url = new URL(request.url);
		const pair = new WebSocketPair();
		const client = pair[0];
		const server = pair[1];
		if (!this.room && url.searchParams.get("create") === "1") {
			const code = normalizeRoomCode(url.searchParams.get("room") ?? "");
			if (code) this.room = createRoomState(code);
		}
		if (!this.room) {
			server.accept();
			this.fail(server, "no_such_room", "That room code does not exist.", CLOSE_BAD_ROOM);
			return new Response(null, {
				status: 101,
				webSocket: client
			});
		}
		const now = Date.now();
		const { meta, reclaimed } = this.resolveSeat(this.room, url);
		this.ctx.acceptWebSocket(server, [meta.playerId ?? "spectator"]);
		server.serializeAttachment(meta);
		if (meta.playerId) for (const other of this.socketsForPlayer(meta.playerId)) {
			if (other === server) continue;
			this.fail(other, "replaced", "You opened this room in another tab.", CLOSE_REPLACED);
		}
		const events = [];
		const player = meta.playerId ? findPlayer(this.room, meta.playerId) : void 0;
		if (player) {
			if (reclaimed && (!player.connected || player.botControlled)) events.push({
				t: "playerReconnected",
				playerId: player.id,
				name: player.name
			});
			else if (!reclaimed) events.push({
				t: "playerJoined",
				playerId: player.id,
				name: player.name
			});
			player.connected = true;
			player.botControlled = false;
			this.clearTimer("grace", player.id);
		}
		this.send(server, {
			t: "welcome",
			youId: meta.playerId,
			token: meta.token,
			spectator: meta.spectator,
			room: serializeFor(this.room, meta.playerId, now),
			chat: this.chat.slice(-60)
		});
		await this.commit(events, now);
		return new Response(null, {
			status: 101,
			webSocket: client
		});
	}
	/**
	* Works out who this connection is: a returning player reclaiming their
	* seat, somebody new taking one, or a spectator.
	*/
	resolveSeat(state, url) {
		const protocol = url.searchParams.get("v") === "2" ? 2 : 1;
		const token = url.searchParams.get("token");
		if (token) {
			const playerId = this.tokens[token];
			if (playerId && findPlayer(state, playerId)) return {
				meta: {
					playerId,
					token,
					spectator: false,
					protocol
				},
				reclaimed: true
			};
		}
		const name = cleanName((url.searchParams.get("name") ?? "").replace(CONTROL_CHARS, ""), "") || randomNickname(cryptoRng);
		const requestedAvatar = Number(url.searchParams.get("avatar"));
		const avatar = Number.isFinite(requestedAvatar) ? Math.abs(Math.trunc(requestedAvatar)) : cryptoRng.int(9);
		const wantsToWatch = url.searchParams.get("spectate") === "1";
		const canSeat = state.phase === "lobby" && state.players.length < 8;
		if (wantsToWatch || !canSeat) return {
			meta: {
				playerId: null,
				token: crypto.randomUUID(),
				spectator: true,
				name,
				avatar,
				joinedAt: Date.now(),
				waitingForSeat: !wantsToWatch,
				protocol
			},
			reclaimed: false
		};
		const id = crypto.randomUUID();
		const fresh = crypto.randomUUID();
		seatPlayer(state, {
			id,
			name,
			avatar
		});
		this.tokens[fresh] = id;
		return {
			meta: {
				playerId: id,
				token: fresh,
				spectator: false,
				protocol
			},
			reclaimed: false
		};
	}
	async webSocketMessage(ws, raw) {
		if (typeof raw !== "string") return;
		const meta = this.metaOf(ws);
		if (!meta) return;
		if (!this.room) {
			this.fail(ws, "no_such_room", "This room has closed.", CLOSE_BAD_ROOM);
			return;
		}
		if (!this.allow(meta)) {
			this.send(ws, {
				t: "error",
				code: "slow_down",
				message: "Slow down a moment."
			});
			return;
		}
		let message;
		try {
			message = JSON.parse(raw);
		} catch {
			this.send(ws, {
				t: "error",
				code: "bad_message",
				message: "That message made no sense."
			});
			return;
		}
		if (!message || typeof message.t !== "string") return;
		const now = Date.now();
		if (message.t === "ping") {
			this.send(ws, {
				t: "pong",
				now
			});
			return;
		}
		if (message.t === "chat" || message.t === "emote") {
			const entry = this.buildChat(meta, message, now);
			if (entry) await this.commitChat(entry, now);
			return;
		}
		if (!meta.playerId) {
			this.send(ws, {
				t: "error",
				code: "spectating",
				message: "You are watching this one."
			});
			return;
		}
		const events = this.handlePlayerMessage(ws, meta.playerId, message, now);
		if (events) await this.commit(events, now);
	}
	/** Returns the events to broadcast, or `null` if nothing changed. */
	handlePlayerMessage(ws, playerId, message, now) {
		const state = this.room;
		const player = findPlayer(state, playerId);
		if (!player) return null;
		const isHost = state.hostId === playerId;
		switch (message.t) {
			case "intent": return this.handleIntent(ws, playerId, message.intent, now);
			case "ready":
				if (state.phase !== "lobby") return null;
				player.ready = message.ready === true;
				return [];
			case "rules":
				if (!this.requireHost(ws, isHost)) return null;
				if (state.phase !== "lobby") {
					this.send(ws, {
						t: "error",
						code: "in_progress",
						message: "Rules are locked once the game starts."
					});
					return null;
				}
				state.rules = applyRuleChange(state.rules, message.patch ?? {});
				return [];
			case "addBot": {
				if (!this.requireHost(ws, isHost)) return null;
				if (state.phase !== "lobby") return null;
				if (state.players.length >= 8) {
					this.send(ws, {
						t: "error",
						code: "room_full",
						message: "The table is full."
					});
					return null;
				}
				const bot = seatPlayer(state, makeBot(state, message.level === "easy" || message.level === "hard" ? message.level : "normal", cryptoRng));
				bot.ready = true;
				return [{
					t: "playerJoined",
					playerId: bot.id,
					name: bot.name
				}];
			}
			case "removePlayer": {
				if (!this.requireHost(ws, isHost)) return null;
				if (state.phase !== "lobby") return null;
				const target = findPlayer(state, message.playerId);
				if (!target || target.id === playerId) return null;
				const name = target.name;
				for (const socket of this.socketsForPlayer(target.id)) this.fail(socket, "removed", "The host removed you from the room.", CLOSE_REPLACED);
				for (const [token, owner] of Object.entries(this.tokens)) if (owner === target.id) delete this.tokens[token];
				unseatPlayer(state, target.id);
				return [{
					t: "playerLeft",
					playerId: target.id,
					name
				}, ...this.promoteSpectators(now)];
			}
			case "start": {
				if (!this.requireHost(ws, isHost)) return null;
				if (state.players.length < 2) {
					this.send(ws, {
						t: "error",
						code: "not_enough_players",
						message: "You need at least 2 players."
					});
					return null;
				}
				if (!canStart(state)) {
					this.send(ws, {
						t: "error",
						code: "not_ready",
						message: "Everybody has to be ready first."
					});
					return null;
				}
				const result = startMatch(state, {
					rng: cryptoRng,
					now
				});
				if (!result.ok) {
					this.send(ws, {
						t: "error",
						code: result.code,
						message: result.message
					});
					return null;
				}
				this.room = result.state;
				return result.events;
			}
			case "nextRound": {
				if (state.phase !== "roundOver") return null;
				player.ready = true;
				const promoted = this.promoteSpectators(now);
				if (state.players.filter((p) => !p.isBot && p.connected && !p.ready).length > 0) return promoted;
				const result = startNextRound(state, {
					rng: cryptoRng,
					now
				});
				if (!result.ok) return promoted;
				this.room = result.state;
				return [...promoted, ...result.events];
			}
			case "newMatch":
				if (!this.requireHost(ws, isHost)) return null;
				if (state.phase !== "matchOver") return null;
				this.resetToLobby(state);
				return this.promoteSpectators(now);
			default: return null;
		}
	}
	/** Same people, same room code, scores wiped. */
	resetToLobby(state) {
		state.phase = "lobby";
		state.result = null;
		state.matchWinnerId = null;
		state.round = 0;
		state.drawPile = [];
		state.discard = [];
		state.activeColor = null;
		state.pending = null;
		state.drawStack = null;
		state.uno = null;
		state.lastPlayerId = null;
		state.turnDeadline = null;
		state.passRecord = [];
		for (const player of state.players) {
			player.hand = [];
			player.score = 0;
			player.roundPoints = 0;
			player.ready = player.isBot;
		}
	}
	/** Seat waiting spectators in arrival order when a game can accept players. */
	promoteSpectators(now) {
		const state = this.room;
		if (!state || state.phase !== "lobby" && state.phase !== "roundOver") return [];
		const waiting = this.ctx.getWebSockets().map((socket) => ({
			socket,
			meta: this.metaOf(socket)
		})).filter((entry) => entry.meta !== null && entry.meta.spectator && entry.meta.playerId === null && entry.meta.waitingForSeat === true).sort((a, b) => (a.meta.joinedAt ?? 0) - (b.meta.joinedAt ?? 0));
		const events = [];
		for (const { socket, meta } of waiting) {
			if (state.players.length >= 8) break;
			const player = seatPlayer(state, {
				id: crypto.randomUUID(),
				name: meta.name ?? randomNickname(cryptoRng),
				avatar: meta.avatar ?? cryptoRng.int(9)
			});
			const nextMeta = {
				...meta,
				playerId: player.id,
				spectator: false
			};
			socket.serializeAttachment(nextMeta);
			this.tokens[meta.token] = player.id;
			this.send(socket, {
				t: "welcome",
				youId: player.id,
				token: meta.token,
				spectator: false,
				room: serializeFor(state, player.id, now),
				chat: this.chat.slice(-60)
			});
			events.push({
				t: "playerJoined",
				playerId: player.id,
				name: player.name
			});
		}
		return events;
	}
	socketsForPlayer(playerId) {
		return this.ctx.getWebSockets().filter((socket) => this.metaOf(socket)?.playerId === playerId);
	}
	handleIntent(ws, playerId, intent, now) {
		const state = this.room;
		if (!intent || typeof intent.type !== "string") return null;
		const result = applyIntent(state, playerId, intent, {
			rng: cryptoRng,
			now
		});
		if (!result.ok) {
			this.send(ws, {
				t: "error",
				code: result.code,
				message: result.message
			});
			return null;
		}
		this.room = result.state;
		return result.events;
	}
	requireHost(ws, isHost) {
		if (isHost) return true;
		this.send(ws, {
			t: "error",
			code: "not_host",
			message: "Only the host can do that."
		});
		return false;
	}
	buildChat(meta, message, now) {
		const state = this.room;
		const player = meta.playerId ? findPlayer(state, meta.playerId) : void 0;
		let text;
		let kind;
		if (message.t === "emote") {
			const emote = EMOTES[message.index];
			if (!emote) return null;
			text = emote.glyph;
			kind = "emote";
		} else if (message.t === "chat") {
			text = String(message.text ?? "").replace(CONTROL_CHARS, " ").trim().slice(0, 160);
			if (!text) return null;
			kind = "chat";
		} else return null;
		return {
			id: crypto.randomUUID(),
			kind,
			playerId: player?.id ?? null,
			name: player?.name ?? "Spectator",
			avatar: player?.avatar ?? null,
			text,
			at: now
		};
	}
	async webSocketClose(ws) {
		await this.dropSocket(ws);
	}
	async webSocketError(ws) {
		await this.dropSocket(ws);
	}
	async dropSocket(ws) {
		const meta = this.metaOf(ws);
		if (!meta || !this.room || !meta.playerId) return;
		if (this.socketsForPlayer(meta.playerId).filter((other) => other !== ws).length > 0) return;
		const player = findPlayer(this.room, meta.playerId);
		if (!player || !player.connected) return;
		const now = Date.now();
		const events = [];
		player.connected = false;
		if (this.room.phase === "lobby") {
			const name = player.name;
			delete this.tokens[meta.token];
			unseatPlayer(this.room, player.id);
			events.push({
				t: "playerLeft",
				playerId: player.id,
				name
			});
			events.push(...this.promoteSpectators(now));
		} else this.setTimer("grace", now + RECONNECT_GRACE_MS, player.id);
		await this.commit(events, now);
	}
	async alarm() {
		this.alarmAt = null;
		const now = Date.now();
		if (!this.room) {
			await this.armAlarm();
			return;
		}
		const due = this.timers.filter((t) => t.at <= now).sort((a, b) => a.at - b.at);
		this.timers = this.timers.filter((t) => t.at > now);
		const events = [];
		for (const timer of due) switch (timer.kind) {
			case "uno":
				this.fireUnoWindow(events, now);
				break;
			case "turn":
				this.fireTurnClock(events, now);
				break;
			case "bot":
				this.fireBotMove(events, now);
				break;
			case "botCatch":
				this.fireBotCatch(events, now);
				break;
			case "grace":
				this.fireGrace(events, timer.playerId);
				break;
			case "cleanup": if (await this.fireCleanup()) return;
		}
		await this.commit(events, now);
	}
	fireUnoWindow(events, now) {
		const state = this.room;
		if (!state.uno || now < state.uno.deadline) return;
		const result = expireUnoWindow(state, {
			rng: cryptoRng,
			now
		});
		if (!result.ok) return;
		this.room = result.state;
		events.push(...result.events);
	}
	fireTurnClock(events, now) {
		const state = this.room;
		if (state.phase !== "playing" || state.turnDeadline === null || now < state.turnDeadline) return;
		const result = timeoutTurn(state, {
			rng: cryptoRng,
			now
		});
		if (!result.ok) return;
		this.room = result.state;
		events.push(...result.events);
	}
	fireBotMove(events, now) {
		const state = this.room;
		const actor = actorId(state);
		if (!actor) return;
		const player = findPlayer(state, actor);
		if (!player || !player.isBot && !player.botControlled) return;
		const intent = decideBotIntent(botView(state, player.id, now), cryptoRng);
		if (!intent) return;
		const result = applyIntent(state, player.id, intent, {
			rng: cryptoRng,
			now
		});
		if (!result.ok) return;
		this.room = result.state;
		events.push(...result.events);
	}
	fireBotCatch(events, now) {
		const window = this.room?.uno;
		if (!window || window.called || now >= window.deadline) return;
		for (const player of this.room.players) {
			if (!player.isBot && !player.botControlled) continue;
			if (player.id === window.playerId) continue;
			const current = this.room;
			const intent = decideBotCatch(botView(current, player.id, now));
			if (!intent) continue;
			const result = applyIntent(current, player.id, intent, {
				rng: cryptoRng,
				now
			});
			if (!result.ok) continue;
			this.room = result.state;
			events.push(...result.events);
			return;
		}
	}
	fireGrace(events, playerId) {
		const state = this.room;
		if (!playerId) return;
		const player = findPlayer(state, playerId);
		if (!player || player.connected || player.botControlled) return;
		if (state.phase === "lobby") {
			unseatPlayer(state, player.id);
			events.push({
				t: "playerLeft",
				playerId: player.id,
				name: player.name
			});
			events.push(...this.promoteSpectators(Date.now()));
			return;
		}
		player.botControlled = true;
		events.push({
			t: "botTookOver",
			playerId: player.id,
			name: player.name
		});
	}
	/** Returns true when the room deleted itself. */
	async fireCleanup() {
		if (this.room.players.some((p) => !p.isBot && p.connected)) return false;
		for (const socket of this.ctx.getWebSockets()) try {
			socket.close(1001, "Room closed.");
		} catch {}
		this.room = null;
		this.chat = [];
		this.tokens = {};
		this.timers = [];
		this.rates.clear();
		await this.ctx.storage.deleteAll();
		await this.ctx.storage.deleteAlarm();
		this.alarmAt = null;
		return true;
	}
	setTimer(kind, at, playerId) {
		this.clearTimer(kind, playerId);
		this.timers.push({
			kind,
			at,
			playerId
		});
	}
	clearTimer(kind, playerId) {
		this.timers = this.timers.filter((t) => !(t.kind === kind && (playerId === void 0 || t.playerId === playerId)));
	}
	/**
	* One alarm, always set to the nearest deadline — and written only when that
	* moves. Most commits change no deadline, and an alarm write is a storage
	* row like any other.
	*/
	async armAlarm() {
		const next = this.timers.length === 0 ? null : this.timers.reduce((min, t) => Math.min(min, t.at), Infinity);
		if (next === this.alarmAt) return;
		this.alarmAt = next;
		if (next === null) await this.ctx.storage.deleteAlarm();
		else await this.ctx.storage.setAlarm(next);
	}
	/**
	* Works out which deadlines the current state needs. Called after every
	* change, so the alarm always reflects the game as it stands.
	*/
	schedule(now) {
		const state = this.room;
		if (!state) return;
		if (state.phase === "playing" && state.turnDeadline !== null) this.setTimer("turn", state.turnDeadline);
		else this.clearTimer("turn");
		if (state.uno) this.setTimer("uno", state.uno.deadline);
		else this.clearTimer("uno");
		const actor = state.phase === "playing" ? actorId(state) : null;
		const player = actor ? findPlayer(state, actor) : void 0;
		if (player && (player.isBot || player.botControlled)) {
			if (!this.timers.some((t) => t.kind === "bot")) this.setTimer("bot", now + botDelay(cryptoRng));
		} else this.clearTimer("bot");
		const window = state.uno;
		const botCanCatch = window !== null && !window.called && state.players.some((p) => (p.isBot || p.botControlled) && p.botLevel !== "easy" && p.id !== window.playerId);
		if (window && botCanCatch) {
			if (!this.timers.some((t) => t.kind === "botCatch")) {
				const delay = randomBetween(BOT_CATCH_MIN_MS, BOT_CATCH_MAX_MS, cryptoRng);
				this.setTimer("botCatch", Math.min(now + delay, window.deadline - 1));
			}
		} else this.clearTimer("botCatch");
		if (!state.players.some((p) => !p.isBot && p.connected)) {
			if (!this.timers.some((t) => t.kind === "cleanup")) this.setTimer("cleanup", now + ROOM_TTL_MS);
		} else this.clearTimer("cleanup");
	}
	/** Storage first, then everyone hears about it. */
	async commit(events, now) {
		const lines = this.narrate(events, now);
		for (const line of lines) this.pushChat(line);
		this.schedule(now);
		await this.persist();
		await this.armAlarm();
		this.sendSync(events, lines, now);
	}
	/** Chat changes no game state or deadline, so it needs neither a room
	* projection nor another alarm write for clients on the compact protocol. */
	async commitChat(entry, now) {
		this.pushChat(entry);
		await this.persist();
		const state = this.room;
		if (!state) return;
		for (const socket of this.ctx.getWebSockets()) {
			const meta = this.metaOf(socket);
			if (!meta) continue;
			if (meta.protocol === 2) this.send(socket, {
				t: "chat",
				messages: [entry]
			});
			else this.send(socket, {
				t: "sync",
				room: serializeFor(state, meta.playerId, now),
				events: [],
				chat: [entry]
			});
		}
	}
	async persist() {
		const stored = {
			room: this.room,
			chat: this.chat,
			tokens: this.tokens,
			timers: this.timers
		};
		await this.ctx.storage.put("room", stored);
	}
	/**
	* The one place game state leaves the Durable Object. Every socket gets a
	* snapshot built for its own player, and events addressed to somebody else
	* are stripped out on the way.
	*/
	sendSync(events, chat, now) {
		const state = this.room;
		if (!state) return;
		let spectatorFrame;
		for (const socket of this.ctx.getWebSockets()) {
			const meta = this.metaOf(socket);
			if (!meta) continue;
			if (meta.playerId === null && spectatorFrame !== void 0) {
				this.send(socket, spectatorFrame);
				continue;
			}
			const visible = events.filter((event) => !("to" in event) || event.to === meta.playerId);
			const message = {
				t: "sync",
				room: serializeFor(state, meta.playerId, now),
				events: visible,
				chat: chat.length > 0 ? chat : void 0
			};
			if (meta.playerId === null) spectatorFrame = JSON.stringify(message);
			this.send(socket, spectatorFrame !== void 0 && meta.playerId === null ? spectatorFrame : message);
		}
	}
	narrate(events, now) {
		const state = this.room;
		if (!state) return [];
		const nameOf = (id) => findPlayer(state, id)?.name ?? "Someone";
		const lines = [];
		for (const event of events) {
			if ("to" in event) continue;
			const text = describeEvent(event, nameOf);
			if (!text) continue;
			lines.push({
				id: crypto.randomUUID(),
				kind: "system",
				playerId: null,
				name: "system",
				avatar: null,
				text,
				at: now
			});
		}
		return lines;
	}
	pushChat(entry) {
		this.chat.push(entry);
		if (this.chat.length > 60) this.chat.splice(0, this.chat.length - 60);
	}
	send(ws, message) {
		try {
			ws.send(typeof message === "string" ? message : JSON.stringify(message));
		} catch {}
	}
	fail(ws, code, message, closeCode) {
		this.send(ws, {
			t: "error",
			code,
			message,
			fatal: true
		});
		try {
			ws.close(closeCode, code);
		} catch {}
	}
	metaOf(ws) {
		return ws.deserializeAttachment() ?? null;
	}
	allow(meta) {
		const key = meta.playerId ?? meta.token;
		const now = Date.now();
		const entry = this.rates.get(key);
		if (!entry || now > entry.until) {
			this.rates.set(key, {
				count: 1,
				until: now + RATE_WINDOW_MS
			});
			return true;
		}
		entry.count++;
		return entry.count <= RATE_LIMIT;
	}
	/** Lets the integration tests look at the room without a socket. */
	async snapshot(playerId = null) {
		if (!this.room) return null;
		return serializeFor(this.room, playerId, Date.now());
	}
	/** Lets the integration tests drive an alarm deterministically. */
	async pendingTimers() {
		return this.timers.map((t) => t.kind);
	}
};
//#endregion
//#region shared/base.ts
var BASE_PATH = "/uno";
/** The same thing with the trailing slash Vite's `base` wants. */
var BASE_URL = `${BASE_PATH}/`;
/** '/api/rooms' -> '/uno/api/rooms'. */
function withBase(path) {
	return `${BASE_PATH}${path}`;
}
/**
* The path as the app sees it, with the mount point taken off — so the Worker
* and the router can be written as if the app owned the whole domain.
*
* Returns null when the request is not under the mount point at all, which is
* how the Worker knows to redirect rather than serve.
*/
function stripBase(pathname) {
	if (pathname === "/uno") return "/";
	if (pathname.startsWith(BASE_URL)) return pathname.slice(4);
	return null;
}
//#endregion
//#region worker/index.ts
/**
* The one Worker. It serves the built client through the Assets binding and
* handles the two dynamic routes:
*
*   POST /api/rooms        create a room, get a code back
*   GET  /api/rooms/:code  is that code real, and can I sit down?
*   GET  /ws?room=CODE     upgrade to that room's Durable Object
*                          (&create=1 makes the room first if it is new)
*
* Single origin, so there is no CORS anywhere in this project.
*
* Those paths are written as if the app owned the whole domain. It does not —
* it is mounted at /uno (see shared/base.ts) — so the mount point comes off
* the front of every request before anything below looks at it.
*/
/** How many times to retry if a generated code is already in use. */
var CODE_ATTEMPTS = 8;
var json = (body, status = 200) => Response.json(body, {
	status,
	headers: { "Cache-Control": "no-store" }
});
var worker_default = { async fetch(request, env) {
	const url = new URL(request.url);
	const path = stripBase(url.pathname);
	if (path === null) return Response.redirect(`${url.origin}${withBase(url.pathname)}${url.search}`, 302);
	if (path === "/ws") return handleSocket(request, env, url);
	if (path === "/api/rooms" && request.method === "POST") return createRoom(env);
	const lookup = path.match(/^\/api\/rooms\/([^/]+)$/);
	if (lookup && request.method === "GET") return roomInfo(env, decodeURIComponent(lookup[1]));
	if (path.startsWith("/api/")) return json({
		error: "not_found",
		message: "No such endpoint."
	}, 404);
	const assetUrl = new URL(path + url.search, url.origin);
	return serveAsset(env, new Request(assetUrl, request), path);
} };
/** Everything under /assets/ has a content hash in its name, so it never changes. */
var IMMUTABLE = "public, max-age=31536000, immutable";
/**
* The Assets binding answers with `max-age=0, must-revalidate` for everything,
* and `_headers` does not apply once the Worker runs first — so the hashed
* build output would be revalidated on every visit. index.html and the SPA
* routes keep that default, which is right for them.
*/
async function serveAsset(env, request, path) {
	const response = await env.ASSETS.fetch(request);
	if (!path.startsWith("/assets/")) return response;
	if (response.headers.get("Content-Type")?.startsWith("text/html")) return new Response("Not found.", {
		status: 404,
		headers: { "Cache-Control": "no-store" }
	});
	if (response.status !== 200 && response.status !== 304) return response;
	const headers = new Headers(response.headers);
	headers.set("Cache-Control", IMMUTABLE);
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers
	});
}
async function createRoom(env) {
	for (let attempt = 0; attempt < CODE_ATTEMPTS; attempt++) {
		const code = makeRoomCode(cryptoRng);
		if (await env.ROOM.get(env.ROOM.idFromName(code)).createIfAbsent(code)) return json({ code });
	}
	return json({
		error: "no_code_available",
		message: "Could not find a free room code. Try again."
	}, 503);
}
async function roomInfo(env, raw) {
	const code = normalizeRoomCode(raw);
	if (!code) return json({
		exists: false,
		reason: "bad_code"
	});
	return json({
		code,
		...await env.ROOM.get(env.ROOM.idFromName(code)).info()
	});
}
function handleSocket(request, env, url) {
	if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return new Response("Expected a WebSocket upgrade.", { status: 426 });
	const code = normalizeRoomCode(url.searchParams.get("room") ?? "");
	if (!code) return new Response("Bad room code.", { status: 400 });
	return env.ROOM.get(env.ROOM.idFromName(code)).fetch(request);
}
//#endregion
//#region \0virtual:cloudflare/worker-entry
var worker_entry_default = worker_default ?? {};
//#endregion
export { Room, worker_entry_default as default };
