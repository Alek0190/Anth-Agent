# Telegram alerts, approvals and calls

Anth-Agent tells you on Telegram when something needs you, and you decide there.

| What happens | On Telegram |
|---|---|
| A ship or rollback waits for your approval | a message with the preview, the pull request and **✅ Approve / ❌ Reject** |
| An approval has waited 10 minutes | **your phone rings** |
| Watch opens an incident | a message, and **your phone rings** at once |
| An incident agent cannot fix it alone | a message, and **your phone rings** |
| A job fails | a message with the error |
| You decide in the hub instead | the message's buttons go away and it says what you chose |

Send `/status` to the bot any time to see what is waiting.

Two Telegram accounts do this:

- **The bot** sends the messages and takes your button presses. Bots cannot make calls.
- **"Anth Alerts"**, a normal Telegram account on your spare phone's SIM, makes the call. The call is a wake-up: it rings, and hangs up when you answer. The alert is waiting in the bot's chat, and the same text is in the Anth Alerts chat.

Run all of this on **one** device only, the always-on agent box (see [HETZNER.md](HETZNER.md)). Two backends with the same bot token block each other.

## 1. Create the bot (5 minutes)

1. In Telegram, open **@BotFather** and send `/newbot`. Name it, for example `Anth Agent`, with a username like `anth_alex_bot`.
2. Copy the token it gives you into `.env`:

   ```bash
   TELEGRAM_BOT_TOKEN=123456:ABC...
   ```

3. Restart the backend, open your bot in Telegram and send `/start`. It answers with your chat id. Put it in `.env`:

   ```bash
   TELEGRAM_CHAT_ID=123456789
   ```

4. Restart the backend and send `/start` again: "Anth-Agent alerts are on". Only this chat can press the buttons.

## 2. Set up the Anth Alerts account (15 minutes, once)

1. Put the spare SIM in the spare phone and install Telegram. Create an account, named for example **Anth Alerts**.
2. Turn on two-step verification for it (Settings → Privacy and Security). Keep the phone charged and somewhere safe. It only has to receive the login code once.
3. On a computer, open [my.telegram.org](https://my.telegram.org), log in **with the spare number**, and go to **API development tools**. Create an app with any name, then copy `api_id` and `api_hash` to `.env`:

   ```bash
   TELEGRAM_API_ID=1234567
   TELEGRAM_API_HASH=0123456789abcdef...
   ```

4. From the Anth-Agent folder, log in once. Enter the spare number, the code Telegram sends to the spare phone, and the two-step password:

   ```bash
   just telegram login
   ```

   This adds `TELEGRAM_CALLER_SESSION` to `.env`. It is a login to that account, so treat it like a password.

5. Say who to call: your own Telegram, as a username or a phone number:

   ```bash
   TELEGRAM_CALL_TO=@your_username
   ```

6. On **your** phone: save the spare number as a contact called "Anth Alerts", and make sure calls from contacts are allowed (Settings → Privacy and Security → Calls). Optionally give the Anth Alerts chat a loud custom ringtone.
7. Test it:

   ```bash
   just telegram call "Test from Anth-Agent"
   ```

   Your phone rings. Answer, and it hangs up straight away. That is the expected behavior.

## 3. Send the keys to the agent box

In `anth-network.yaml`, give the agent box its own `env_keys`. A device's list replaces the defaults, so list every key it needs:

```yaml
devices:
  hetzner:
    # … as in HETZNER.md
    env_keys: [OPENROUTER_API_KEY, TYPESAFE_API_KEY, GITHUB_TOKEN, VERCEL_TOKEN, ANTH_DEPLOY_SSH_KEY,
               TELEGRAM_BOT_TOKEN, TELEGRAM_DEVICE, TELEGRAM_CHAT_ID, TELEGRAM_API_ID, TELEGRAM_API_HASH, TELEGRAM_CALLER_SESSION, TELEGRAM_CALL_TO]
```

Also put `TELEGRAM_DEVICE=hetzner` in `.env`. A backend you run on your laptop reads the same `.env`; with this line it leaves the bot alone, so only the agent box polls it.

Then run `just net up hetzner`. Do not add the Telegram keys to `defaults`.

Agents never see any of these keys: they run with a clean environment.

## Settings

| Key | Default | Meaning |
|---|---|---|
| `ANTH_RING_AFTER_MIN` | `10` | Call when an approval has waited this many minutes; `off` never calls for approvals. Incidents always call. |
| `ANTH_RING_COMMAND` | | Your own call script instead of the Anth Alerts account. It gets the alert in `$ANTH_RING_TEXT`. Use it for an ordinary phone call from a service such as Twilio. |

## Good to know

- **Approving from Telegram is approving production.** Anyone who can use your Telegram can press the button, so keep two-step verification on your own account too.
- **No public URL is needed.** The bot asks Telegram for button presses (long polling), so it works on the agent box behind Tailscale.
- **The call has no voice yet.** Telegram calls need a real-time audio stack. Having the call read the alert aloud is the next step.
- **Restarts are safe.** What was sent is remembered (`telegram.db` in the backend's data folder), so nothing is sent twice. Old failures and incidents are not sent when you first switch alerts on.
