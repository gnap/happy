import { describe, expect, it } from "vitest";
import { withSessionPresence } from "./merge";
import type { SessionPresence } from "./sessionCache";

const row = {
    id: "session-1",
    active: true,
    lastActiveAt: new Date(5_000),
};

const presence = (over: Partial<SessionPresence> = {}): SessionPresence => ({
    userId: "user-1",
    active: true,
    thinking: true,
    thinkingAt: 3_000,
    activeAt: 4_000,
    startedAt: 1_000,
    endedAt: 0,
    ...over,
});

describe("withSessionPresence", () => {
    it("prefers the live presence to the database checkpoint", () => {
        expect(withSessionPresence(row, presence())).toMatchObject({
            active: true,
            activeAt: 4_000,
            thinking: true,
            thinkingAt: 3_000,
        });
    });

    it("shows a session that ended as offline at its end time", () => {
        expect(withSessionPresence(row, presence({ active: false, thinking: false, thinkingAt: 0, activeAt: 6_000 })))
            .toMatchObject({ active: false, activeAt: 6_000, thinking: false, thinkingAt: 0 });
    });

    it("falls back to the row when this server has not seen the session yet", () => {
        // A freshly started server has no presence; its rows are still a usable answer.
        expect(withSessionPresence(row, null)).toMatchObject({
            active: true,
            activeAt: 5_000,
            thinking: false,
            thinkingAt: 0,
        });
    });
});
