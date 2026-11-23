/**
 * Out-of-band security alerts (new client registrations, consent approvals,
 * failed consent attempts, bursts of bad tokens). Telegram when configured;
 * always echoed to stderr, which ends up in the service log.
 */
export interface Notifier {
  alert(message: string): void;
}

export class ConsoleNotifier implements Notifier {
  alert(message: string): void {
    console.error(`[obsidian-mcp] ALERT ${message}`);
  }
}

export class TelegramNotifier implements Notifier {
  constructor(
    private botToken: string,
    private chatId: string,
    private fallback: Notifier = new ConsoleNotifier()
  ) {}

  alert(message: string): void {
    this.fallback.alert(message);
    // Fire and forget: an alert must never block or fail a request.
    fetch(`https://api.telegram.org/bot${this.botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: this.chatId,
        text: `🔐 vault-mcp: ${message}`,
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(5000),
    }).catch((err) => {
      console.error(`[obsidian-mcp] Telegram alert failed: ${err?.message ?? err}`);
    });
  }
}

export function createNotifier(botToken?: string, chatId?: string): Notifier {
  return botToken && chatId
    ? new TelegramNotifier(botToken, chatId)
    : new ConsoleNotifier();
}
