import { useState } from "react";
import { Photo } from "./Photo";
import { useSceneProgress } from "./useSceneProgress";

const MARKETS: { word: string; language: string; text: string; photo: string; phone: 800 | 1200; position: string; alt: string }[] = [
  {
    word: "Oja",
    language: "Yoruba",
    text: "From Balogun to Dugbe, trade built on names people know and trust.",
    photo: "aso-oke-portrait",
    phone: 800,
    position: "50% 20%",
    alt: "A woman wearing hand-woven aso-oke",
  },
  {
    word: "Ahia",
    language: "Igbo",
    text: "From Onitsha to Ariaria, the craft of buying well and selling better.",
    photo: "ankara-textiles",
    phone: 1200,
    position: "50% 50%",
    alt: "Stacks of Ankara fabric on display",
  },
  {
    word: "Kasuwa",
    language: "Hausa",
    text: "From Kurmi to Sabon Gari, centuries of commerce across the Sahel.",
    photo: "merchant-shop",
    phone: 1200,
    position: "50% 30%",
    alt: "A shopkeeper smiling at the counter of her well-stocked store",
  },
];

/** The name itself: three words for market, one full screen each. */
export function MarketsScene() {
  const [active, setActive] = useState(0);
  const ref = useSceneProgress<HTMLElement>((progress) => {
    setActive(Math.min(MARKETS.length - 1, Math.floor(progress * MARKETS.length)));
  });

  return (
    <section ref={ref} className="oak-markets-scene">
      <div className="oak-markets-stage">
        {MARKETS.map((market, index) => (
          <figure key={market.word} className={`oak-market ${index === active ? "is-active" : ""}`} aria-hidden={index !== active}>
            <Photo name={market.photo} phone={market.phone} lazy alt={market.alt} position={market.position} />
            <figcaption className="mx-auto w-full max-w-7xl px-6 pb-14 lg:px-10 lg:pb-20">
              <p className="oak-eyebrow text-[#E7C98A]">{market.language} for market</p>
              <h3 className="oak-display oak-market-word">{market.word}</h3>
              <p className="max-w-md text-lg leading-relaxed text-[#F7F2E7]">{market.text}</p>
            </figcaption>
          </figure>
        ))}
        <p className="oak-markets-lead oak-display">Three words for market. One name.</p>
      </div>
    </section>
  );
}
