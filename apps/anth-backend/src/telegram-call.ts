// Ring you on Telegram from a second account ("Anth Alerts"): bots cannot call, user accounts can.
//
// One ring: connect with the saved session, send the alert text as a message (so the call has context), request a
// call, let it ring, and hang up when you answer, decline, or after ringSeconds. The call carries no audio yet: it is
// a wake-up. The alert itself, and the Approve / Reject buttons, are in the bot's chat.
//
// Set up with `just telegram login` (TELEGRAM_API_ID / TELEGRAM_API_HASH from my.telegram.org, logged in as the alerts
// account), then TELEGRAM_CALL_TO = your @username or phone number.
import { createHash, randomBytes, randomInt } from "node:crypto";
import { Api, TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { Raw } from "telegram/events/index.js";
import { returnBigInt } from "telegram/Helpers.js";

export interface RingOptions {
  apiId: number;
  apiHash: string;
  /** The alerts account's saved login (`just telegram login`). */
  session: string;
  /** Who to call: @username or +phone. */
  to: string;
  text: string;
  ringSeconds?: number;
}

/** Connect as the alerts account with a saved session, quietly. */
export function callerClient(apiId: number, apiHash: string, session: string) {
  const client = new TelegramClient(new StringSession(session), apiId, apiHash, { connectionRetries: 3 });
  client.setLogLevel("error" as never);
  return client;
}

/** b^e mod m for BigInts. */
function modPow(b: bigint, e: bigint, m: bigint) {
  let r = 1n;
  b %= m;
  for (; e > 0n; e >>= 1n, b = (b * b) % m) if (e & 1n) r = (r * b) % m;
  return r;
}

/** The big-endian bytes of n, padded to len. */
function toBytes(n: bigint, len: number) {
  return Buffer.from(n.toString(16).padStart(len * 2, "0"), "hex");
}

/** The user to call: a @username, or a phone number added to the alerts account's contacts. */
async function resolveUser(client: TelegramClient, to: string): Promise<Api.TypeInputUser> {
  if (to.startsWith("+")) {
    const res = await client.invoke(
      new Api.contacts.ImportContacts({ contacts: [new Api.InputPhoneContact({ clientId: returnBigInt(1), phone: to, firstName: "Anth", lastName: "Owner" })] }),
    );
    const user = res.users[0];
    if (!(user instanceof Api.User)) throw Error(`No Telegram account for ${to}, or its privacy settings hide it`);
    return new Api.InputUser({ userId: user.id, accessHash: user.accessHash ?? returnBigInt(0) });
  }
  const peer = await client.getInputEntity(to);
  if (!(peer instanceof Api.InputPeerUser)) throw Error(`${to} is not a Telegram user`);
  return new Api.InputUser({ userId: peer.userId, accessHash: peer.accessHash });
}

/** Place one call: message first, then ring until answered, declined or ringSeconds. */
export async function ring(o: RingOptions) {
  const client = callerClient(o.apiId, o.apiHash, o.session);
  await client.connect();
  try {
    if (!(await client.checkAuthorization())) throw Error("The alerts account is logged out: run just telegram login again");
    const user = await resolveUser(client, o.to);
    await client.sendMessage(user, { message: `📞 ${o.text}` });

    // The call request needs the hash of g^a (Diffie-Hellman); the key exchange is never completed, so no audio.
    const dh = await client.invoke(new Api.messages.GetDhConfig({ version: 0, randomLength: 256 }));
    if (!(dh instanceof Api.messages.DhConfig)) throw Error("Telegram sent no DH config");
    const p = BigInt(`0x${dh.p.toString("hex")}`);
    const a = BigInt(`0x${randomBytes(256).toString("hex")}`);
    const gA = toBytes(modPow(BigInt(dh.g), a, p), 256);

    const answered = new Promise<"answered" | "ended">((resolve) => {
      client.addEventHandler(
        (u: Api.UpdatePhoneCall) => {
          if (u.phoneCall instanceof Api.PhoneCallAccepted) resolve("answered");
          else if (u.phoneCall instanceof Api.PhoneCallDiscarded) resolve("ended");
        },
        new Raw({ types: [Api.UpdatePhoneCall] }),
      );
    });
    const res = await client.invoke(
      new Api.phone.RequestCall({
        userId: user,
        randomId: randomInt(1, 2 ** 31 - 1),
        gAHash: createHash("sha256").update(gA).digest(),
        protocol: new Api.PhoneCallProtocol({ udpP2p: true, udpReflector: true, minLayer: 65, maxLayer: 92, libraryVersions: ["2.4.4", "4.0.0", "11.0.0"] }),
        video: false,
      }),
    );
    const call = res.phoneCall as Api.PhoneCallWaiting;
    const outcome = await Promise.race([answered, new Promise<"missed">((r) => setTimeout(() => r("missed"), (o.ringSeconds ?? 45) * 1000))]);
    if (outcome !== "ended")
      await client
        .invoke(
          new Api.phone.DiscardCall({
            peer: new Api.InputPhoneCall({ id: call.id, accessHash: call.accessHash }),
            duration: 0,
            reason: outcome === "missed" ? new Api.PhoneCallDiscardReasonMissed() : new Api.PhoneCallDiscardReasonHangup(),
            connectionId: returnBigInt(0),
          }),
        )
        .catch(() => {});
    return outcome;
  } finally {
    await client.disconnect().catch(() => {});
    await client.destroy().catch(() => {});
  }
}
