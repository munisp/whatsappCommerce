const IVORY = "#F7F2E7";
const FOREST = "#1F3A2D";
const BRASS = "#B08D45";

/** Three growth rings for Oja, Ahia and Kasuwa, forming the O of OAK, around a cowrie. */
export function OakMark({ className, tone = "dark" }: { className?: string; tone?: "dark" | "light" }) {
  const ring = tone === "light" ? IVORY : FOREST;
  return (
    <svg viewBox="0 0 64 64" className={className} role="img" aria-label="OAK">
      <circle cx="32" cy="32" r="28" fill="none" stroke={ring} strokeWidth="3.6" />
      <circle cx="32" cy="32" r="20.4" fill="none" stroke={ring} strokeWidth="2.2" />
      <path
        fill={BRASS}
        fillRule="evenodd"
        d="M32 20.5c6.2 0 9.2 5 9.2 11.5s-3 11.500-9.200 11.500-9.200-5-9.200-11.500 3-11.500 9.200-11.500zM32 24.500c-1.500 2.200-2.100 4.800-2.100 7.500s.6 5.300 2.100 7.500c1.500-2.200 2.100-4.800 2.100-7.500s-.6-5.300-2.100-7.500z"
      />
    </svg>
  );
}

export function OakLogo({ className = "", tone = "dark", size = "md" }: { className?: string; tone?: "dark" | "light"; size?: "sm" | "md" | "lg" }) {
  const sizes = { sm: ["h-7 w-7", "text-xl"], md: ["h-9 w-9", "text-2xl"], lg: ["h-12 w-12", "text-4xl"] }[size];
  return (
    <span className={`inline-flex items-center gap-2.5 ${className}`} aria-label="OAK">
      <OakMark className={sizes[0]} tone={tone} />
      <span aria-hidden="true" className={`oak-display ${sizes[1]} tracking-[0.06em] ${tone === "light" ? "text-[#F7F2E7]" : "text-[#1F3A2D]"}`}>OAK</span>
    </span>
  );
}
