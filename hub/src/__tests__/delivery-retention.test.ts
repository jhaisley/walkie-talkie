import { beforeAll, describe, expect, it } from "vitest";

process.env.WALKIE_TALKIE_DB_PATH = ":memory:";

const { initDB, dbRecordDelivery, dbGetDeliveriesAfter, dbGetDeliveryHighWater } = await import("../db.js");

function msg(id: string) {
  return { id, from: "a", to: "@b", content: id, channel: "#all", timestamp: Date.now() };
}

describe("delivery log retention", () => {
  beforeAll(() => {
    initDB();
  });

  it("bounds a recipient's log instead of growing without limit", () => {
    process.env.WALKIE_TALKIE_DELIVERY_RETENTION = "10";
    for (let i = 0; i < 50; i++) dbRecordDelivery("bounded", msg(`m${i}`));
    // Read the whole log from before the first row; only the retained tail should survive.
    const { messages } = dbGetDeliveriesAfter("bounded", 0, 1000);
    expect(messages.length).toBe(10);
    expect(messages[messages.length - 1].id).toBe("m49"); // newest kept
    expect(messages[0].id).toBe("m40"); // oldest kept
  });

  it("keeps the cursor monotonic across a prune", () => {
    process.env.WALKIE_TALKIE_DELIVERY_RETENTION = "5";
    for (let i = 0; i < 20; i++) dbRecordDelivery("mono", msg(`x${i}`));
    const hw = dbGetDeliveryHighWater("mono");
    const { cursor } = dbGetDeliveriesAfter("mono", 0, 1000);
    expect(cursor).toBe(hw); // pruning old rows must not rewind the high-water mark
  });

  it("does not prune one recipient's log when another is written", () => {
    process.env.WALKIE_TALKIE_DELIVERY_RETENTION = "3";
    dbRecordDelivery("keep", msg("k1"));
    dbRecordDelivery("keep", msg("k2"));
    for (let i = 0; i < 10; i++) dbRecordDelivery("noisy", msg(`n${i}`));
    expect(dbGetDeliveriesAfter("keep", 0, 1000).messages.length).toBe(2);
  });

  it("falls back to the default on invalid configuration", () => {
    process.env.WALKIE_TALKIE_DELIVERY_RETENTION = "not-a-number";
    for (let i = 0; i < 5; i++) dbRecordDelivery("fallback", msg(`f${i}`));
    // Default is far above 5, so nothing is pruned.
    expect(dbGetDeliveriesAfter("fallback", 0, 1000).messages.length).toBe(5);
  });
});
