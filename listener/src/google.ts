// Jarvis's own Google sign-in: one OAuth client in a Google Cloud project made for Jarvis and one
// refresh token covering mail and calendar, all three in the Keychain. Stored by jobs/google_consent.ts.
// Nothing here reads a file, so no other tool's folder can take Jarvis's access away.
import { keychain } from "./keychain";

export const CLIENT_ID_SERVICE = "jarvis_google_client_id";
export const CLIENT_SECRET_SERVICE = "jarvis_google_client_secret";
export const TOKEN_SERVICE = "jarvis_google_token";

// The least that covers what the tools do: read mail, save and send drafts, read and write events.
export const SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.compose",
  "https://www.googleapis.com/auth/calendar.events",
];

export interface GoogleSignIn {
  refresh_token: string;
  client_id: string;
  client_secret: string;
}

/** The OAuth client alone, for the consent job. */
export function googleClient(): { client_id: string; client_secret: string } {
  return { client_id: keychain(CLIENT_ID_SERVICE), client_secret: keychain(CLIENT_SECRET_SERVICE) };
}

export function googleSignIn(): GoogleSignIn {
  return { refresh_token: keychain(TOKEN_SERVICE), ...googleClient() };
}
