// Server text is untrusted: an error can echo back what we sent it, and what we
// sent includes a signed payment or a wallet proof. Everything a server says in
// an error passes through here before it can reach a tool result or stderr.

const REDACTED = "[redacted]";
const MAX_SERVER_TEXT = 500;
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** A SIWX message runs to the end of the text, so it all goes. */
const PROOF_MESSAGE = /\S*\s*wants you to sign in with[\s\S]*/gi;

const LABELLED_SECRET =
  /((?:payment-signature|payment-required|payment-response|x-payment|sign-in-with-x|authorization|agent_token|claim_credential|credential|private_key)["'\\]*\s*[:=]\s*["'\\]*)(?![{[])(?:bearer\s+)?[^\s"',;}\\]+/gi;

const STASHWISE_TOKEN = /\bsw_[a-z]+_[A-Za-z0-9_-]+/g;

/** Signatures, nonces, base64 headers and credentials are all long unbroken runs. */
const LONG_RUN = /[A-Za-z0-9+/_%=-]{40,}/g;

export function redactServerText(text: string): string {
  return text
    .replace(PROOF_MESSAGE, REDACTED)
    .replace(LABELLED_SECRET, `$1${REDACTED}`)
    .replace(STASHWISE_TOKEN, REDACTED)
    .replace(LONG_RUN, (run) => (EVM_ADDRESS.test(run) ? run : REDACTED))
    .slice(0, MAX_SERVER_TEXT);
}
