import { useEffect, useRef, useState } from "react";
import { Check, ShieldCheck } from "lucide-react";
import { useSceneProgress } from "./useSceneProgress";

type Message =
  | { kind: "in" | "out"; text: string }
  | { kind: "product" }
  | { kind: "pay"; text: string }
  | { kind: "system"; text: string };

const STEPS: { title: string; text: string; status: string; short: string; messages: Message[] }[] = [
  {
    title: "A customer says hello.",
    text: "There's nothing to download. Your catalogue arrives right in the chat they already use.",
    status: "New enquiry",
    short: "Asked",
    messages: [
      { kind: "in", text: "Good morning. Do you have ankara?" },
      { kind: "out", text: "Good morning! Here's what came in today." },
      { kind: "product" },
    ],
  },
  {
    title: "They order in a few taps.",
    text: "The order is added up for them, with a safe way to pay in the same conversation.",
    status: "Awaiting payment",
    short: "Ordered",
    messages: [
      { kind: "in", text: "Beautiful. I'll take two." },
      { kind: "pay", text: "2 × Ankara, 6 yards. Total ₦37,000." },
    ],
  },
  {
    title: "The money waits safely.",
    text: "Payment is held until the order arrives, so a buyer can trust a shop they've only just met.",
    status: "Paid, held safely",
    short: "Held",
    messages: [
      { kind: "system", text: "Payment received. OAK is holding it until your order arrives." },
      { kind: "out", text: "Thank you! We're packing it now." },
    ],
  },
  {
    title: "Delivered. Paid. Back next month.",
    text: "The shop gets its money, the customer gets their cloth, and both know they can do it again.",
    status: "Paid out",
    short: "Paid",
    messages: [
      { kind: "in", text: "It's here, and it's lovely!" },
      { kind: "system", text: "Delivery confirmed. ₦37,000 released to Adunni Fabrics." },
    ],
  },
];

function Bubble({ message }: { message: Message }) {
  if (message.kind === "product") {
    return (
      <div className="oak-bubble oak-bubble-out oak-bubble-product">
        <img src="/images/oak/photos/ankara-textiles-800.webp" alt="Stacks of Ankara fabric" />
        <p className="font-semibold">Ankara, 6 yards</p>
        <p className="tabular-nums">₦18,500</p>
      </div>
    );
  }
  if (message.kind === "pay") {
    return (
      <div className="oak-bubble oak-bubble-out">
        {message.text}
        <span className="oak-bubble-action">Pay ₦37,000</span>
      </div>
    );
  }
  if (message.kind === "system") {
    return (
      <div className="oak-bubble oak-bubble-system">
        <ShieldCheck className="h-4 w-4 shrink-0" />
        <span>{message.text}</span>
      </div>
    );
  }
  return <div className={`oak-bubble oak-bubble-${message.kind}`}>{message.text}</div>;
}

/** One sale, start to finish. Scrolling plays the conversation, so visitors see the product, not a description of it. */
export function ChatScene({ id }: { id: string }) {
  const [step, setStep] = useState(0);
  const feedRef = useRef<HTMLDivElement>(null);
  const sceneRef = useSceneProgress<HTMLElement>((progress) => {
    setStep(Math.min(STEPS.length - 1, Math.floor(progress * STEPS.length)));
  });
  const messages = STEPS.slice(0, step + 1).flatMap((item, stepIndex) =>
    item.messages.map((message, index) => ({ message, key: `${stepIndex}-${index}`, order: index })),
  );

  // Fills from the top like a real chat, then keeps the newest message in view.
  useEffect(() => {
    const feed = feedRef.current;
    if (feed) feed.scrollTo({ top: feed.scrollHeight, behavior: "smooth" });
  }, [step]);

  return (
    <section ref={sceneRef} id={id} className="oak-chat-scene">
      <div className="oak-chat-stage">
        <div className="mx-auto grid h-full w-full max-w-7xl items-center gap-6 px-6 py-6 lg:grid-cols-2 lg:gap-16 lg:px-10 lg:py-10">
          <div>
            <p className="oak-eyebrow text-[#A64B27]">One sale on OAK</p>
            <div className="oak-stack mt-3 lg:mt-5">
              {STEPS.map((item, index) => (
                <div key={item.title} className={`oak-chat-caption ${index === step ? "is-active" : ""}`} aria-hidden={index !== step}>
                  <h2 className="oak-display text-3xl leading-tight text-[var(--oak-forest)] sm:text-4xl lg:text-6xl">{item.title}</h2>
                  <p className="mt-3 max-w-md text-base leading-relaxed text-muted-foreground lg:mt-6 lg:text-lg">{item.text}</p>
                </div>
              ))}
            </div>
            <ol className="oak-track mt-5 lg:mt-10">
              {STEPS.map((item, index) => (
                <li key={item.status} className={index <= step ? "is-done" : ""}>
                  <span>{index < step ? <Check className="h-3 w-3" /> : null}</span>
                  <small>{item.short}</small>
                </li>
              ))}
            </ol>
          </div>

          <div className="oak-phone-wrap">
            <div className="oak-phone">
              <div className="oak-phone-head">
                <span className="oak-phone-avatar oak-display">A</span>
                <div>
                  <p className="text-sm font-semibold">Adunni Fabrics</p>
                  <p className="text-xs opacity-75">An example conversation</p>
                </div>
              </div>
              <div ref={feedRef} className="oak-phone-feed" aria-live="polite">
                {messages.map(({ message, key, order }) => (
                  <div key={key} className="oak-bubble-in-view" style={{ "--i": order } as React.CSSProperties}>
                    <Bubble message={message} />
                  </div>
                ))}
              </div>
            </div>
            <aside className="oak-ledger" aria-label="The same order on the shop's dashboard">
              <p className="oak-eyebrow text-muted-foreground">On your dashboard</p>
              <p className="mt-2 text-sm font-semibold">Order #1042</p>
              <p className="oak-display mt-1 text-2xl tabular-nums text-[var(--oak-forest)]">{step === 0 ? "₦18,500" : "₦37,000"}</p>
              <p key={step} className="oak-ledger-status mt-2 text-sm">{STEPS[step].status}</p>
            </aside>
          </div>
        </div>
      </div>
    </section>
  );
}
