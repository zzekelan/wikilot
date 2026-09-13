const PERSISTENCE_TIMEOUT_MS = 5_000;
const POLL_INTERVAL_MS = 5;

type TurnOutcome =
  | { status: "pending" }
  | { status: "settled" }
  | { status: "rejected"; error: unknown };

function delay(ms: number): Promise<TurnOutcome> {
  return new Promise((resolve) => {
    setTimeout(() => resolve({ status: "pending" }), ms);
  });
}

/** Wait until Pi exposes the user message directly below its Prompt record. */
export async function waitForPersistedUserMessage(
  isPersisted: () => boolean,
  turn: Promise<void>,
): Promise<void> {
  const outcome = turn.then<TurnOutcome, TurnOutcome>(
    () => ({ status: "settled" }),
    (error: unknown) => ({ status: "rejected", error }),
  );

  for (;;) {
    if (isPersisted()) return;
    const state = await Promise.race([outcome, delay(POLL_INTERVAL_MS)]);
    if (state.status === "rejected") throw state.error;
    if (state.status === "settled") break;
  }

  // Async message_end hooks may still be appending the user message after the
  // AgentSession Turn settles. Give persistence its own complete deadline.
  const deadline = Date.now() + PERSISTENCE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (isPersisted()) return;
    await delay(POLL_INTERVAL_MS);
  }
  if (isPersisted()) return;
  throw new Error("Prompt user message was not durably paired with its Prompt record");
}
