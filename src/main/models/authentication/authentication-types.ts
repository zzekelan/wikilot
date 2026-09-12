import type { AuthType } from "@earendil-works/pi-ai";
import type { AuthenticationEvent, AuthenticationPrompt } from "../../../shared/settings";

export type AuthenticationRequest = {
  providerId: string;
  type: AuthType;
};

export type { AuthenticationEvent, AuthenticationPrompt };

export type AuthenticationSessionEvent =
  | { type: "prompt"; promptId: string; prompt: AuthenticationPrompt }
  | { type: "event"; event: AuthenticationEvent }
  | { type: "completed"; credential: { providerId: string; type: AuthType } }
  | { type: "failed"; message: string }
  | { type: "cancelled" };
