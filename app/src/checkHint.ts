// Which hint (a key under check.hint) explains a server check step.
import type { ServerCheck, ServerCheckStep } from "rdweb";

export const CHECK_HINTS = ["rendezvous", "relay", "badUrl", "keyMismatch", "keyInvalid", "keySkipped", "notReached", "online", "offline", "noAnswer"] as const;
export type CheckHint = (typeof CHECK_HINTS)[number];

export function checkHint(step: ServerCheckStep, result: ServerCheck): CheckHint | null {
  const reached = result.steps.find((s) => s.id === "rendezvous")?.status === "ok";
  switch (step.id) {
    case "rendezvous":
      if (step.status !== "fail") return null;
      return step.code === "bad-config" ? "badUrl" : "rendezvous";
    case "relay":
      if (step.status !== "fail") return null;
      return step.code === "bad-config" ? "badUrl" : "relay";
    case "key":
      if (step.status === "fail") return step.code === "key-mismatch" ? "keyMismatch" : "keyInvalid";
      if (step.status === "skip") return reached ? "keySkipped" : "notReached";
      return null;
    case "device":
      if (step.status === "ok") return "online";
      if (step.status === "skip") return "notReached";
      return step.code === "offline" ? "offline" : "noAnswer";
  }
}
