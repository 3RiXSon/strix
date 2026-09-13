import { useState } from "react";
import { ArrowLeft, AlertCircle, CheckCircle2 } from "lucide-react";
import { IoChatbubblesOutline } from "react-icons/io5";
import { submitFeedback } from "@/data/serverSource";
import { card, primaryBtn } from "@/lib/ui";
import type { View } from "@/App";

const MAX_MESSAGE = 5000;

const ERROR_COPY: Record<string, string> = {
  invalid_email: "That email doesn't look right.",
  invalid_message: "Please write a little more.",
  unavailable: "Couldn't send that just now. Try again.",
};

/**
 * Feedback & support form. Collects a message plus a work email (no
 * verification — the email is taken as-is) and relays it to Strix via the local
 * server. Mirrors EmailReportView's centered-card styling and palette.
 */
export default function FeedbackView({
  defaultEmail,
  onExit,
}: {
  defaultEmail: string | null;
  onExit: (dest: View) => void;
}) {
  const [message, setMessage] = useState("");
  const [email, setEmail] = useState(defaultEmail ?? "");
  const [step, setStep] = useState<"form" | "sending" | "sent">("form");
  const [error, setError] = useState<string | null>(null);

  const canSend = message.trim().length > 0 && email.trim().length > 0 && step !== "sending";

  const send = async () => {
    if (!canSend) return;
    setStep("sending");
    setError(null);
    const result = await submitFeedback(message.trim(), email.trim());
    if (result.ok) {
      setStep("sent");
      return;
    }
    setStep("form");
    setError(ERROR_COPY[result.error] ?? ERROR_COPY.unavailable);
  };

  return (
    <div className="mx-auto max-w-xl space-y-4">
      <button
        onClick={() => onExit("overview")}
        className="cursor-pointer inline-flex items-center gap-1.5 text-sm text-white/45 transition-colors hover:text-white"
      >
        <ArrowLeft className="h-4 w-4" />
        Back to results
      </button>

      <div className="flex items-center gap-2">
        <IoChatbubblesOutline className="h-5 w-5 text-white/45" aria-hidden="true" />
        <h1 className="text-xl font-semibold text-white sm:text-2xl">Feedback &amp; support</h1>
      </div>

      <div className={`${card} w-full p-5 sm:p-6`}>
        {step === "sent" ? (
          <div className="flex items-start gap-3">
            <CheckCircle2 className="mt-0.5 h-5 w-5 flex-shrink-0 text-emerald-400" aria-hidden="true" />
            <div className="min-w-0">
              <p className="text-sm font-semibold text-white">Thanks, we got it.</p>
              <p className="mt-1 text-xs text-white/45">
                We read every message. If it needs a reply, we&apos;ll reach out to the email you gave.
              </p>
              <button
                onClick={() => {
                  setMessage("");
                  setStep("form");
                }}
                className="mt-4 cursor-pointer text-xs text-white/45 transition-colors hover:text-white"
              >
                Send more feedback
              </button>
            </div>
          </div>
        ) : (
          <>
            <p className="mb-4 text-xs text-white/35">
              Bugs, feature requests, or anything else. Tell us what&apos;s on your mind.
            </p>

            {error && (
              <div className="mb-4 flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/5 px-3 py-2">
                <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0 text-red-400" aria-hidden="true" />
                <p className="text-xs text-red-300">{error}</p>
              </div>
            )}

            <label className="block">
              <span className="mb-1.5 block text-xs text-white/45">Your feedback</span>
              <textarea
                autoFocus
                value={message}
                maxLength={MAX_MESSAGE}
                onChange={(e) => setMessage(e.target.value)}
                rows={5}
                placeholder="What's working, what's not, what you'd love to see…"
                className="w-full resize-y rounded-lg border border-white/15 bg-black px-3 py-2.5 text-sm text-white outline-none transition-colors focus:border-white/40"
              />
            </label>

            <label className="mt-4 block">
              <span className="mb-1.5 block text-xs text-white/45">Your work email</span>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@company.com"
                className="w-full rounded-lg border border-white/15 bg-black px-3 py-2.5 text-sm text-white outline-none transition-colors focus:border-white/40"
              />
            </label>

            <button onClick={() => void send()} disabled={!canSend} className={`${primaryBtn} mt-4 w-full`}>
              {step === "sending" ? "Sending…" : "Send feedback"}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
