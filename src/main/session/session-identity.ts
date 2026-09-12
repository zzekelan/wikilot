/** Internal map key for an explicit Session identity. Never crosses a contract. */
export function sessionIdentityKey(
  workspaceId: string,
  sessionId: string,
): string {
  return `${workspaceId}/${sessionId}`;
}
