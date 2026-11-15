// "Request approval": connect with no password and wait for the remote user.
// The error codes the connection layer raises for it, with their messages in
// the catalog under errors.<code>.

export const APPROVAL_ERRORS = ["approval-unavailable", "approval-timeout", "approval-ended", "approval-declined"] as const;

/**
 * The error code to show. A remote that closes the link while we wait for it
 * to accept (the connection layer reports it as "remote-closed") declined;
 * everything else keeps its code.
 */
export function approvalErrorCode(code: string | undefined, approval: boolean, waiting: boolean): string | undefined {
  return approval && waiting && code === "remote-closed" ? "approval-declined" : code;
}
