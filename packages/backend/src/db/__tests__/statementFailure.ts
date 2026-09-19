/**
 * Assert that a statement is REFUSED, without relying on a matcher to run it.
 *
 * `expect(client`…`).rejects.toThrow()` HANGS against postgres.js, and the
 * reason is worth knowing: a postgres.js query is a lazy thenable — the
 * statement is not sent until something calls `.then()` on it. Bun's `rejects`
 * matcher does not, so the query is never executed, the promise never settles,
 * and the test sits there until the runner is killed. Measured on bun 1.4.2;
 * the suite hung with no output at all, which reads exactly like a database
 * that is not answering.
 *
 * So the statement is awaited HERE, inside a `try`, and the caller asserts on
 * the message. A statement that unexpectedly SUCCEEDS throws rather than
 * returning an empty string, because "no error" must never satisfy a regex the
 * caller wrote expecting one.
 */
export async function statementFailure(run: () => PromiseLike<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('Expected the statement to be refused, but it succeeded.');
}
