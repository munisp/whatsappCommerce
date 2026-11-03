import { PHOTO_PREVIEWS } from "./photoPreviews";

const WIDTHS = [480, 800, 1200, 1600] as const;
type Width = (typeof WIDTHS)[number];

type Props = {
  name: string;
  alt: string;
  /** The file phones get. A phone's pixel density would otherwise make it fetch the largest size. */
  phone?: Width;
  /** The largest file larger screens may fetch. */
  largest?: Width;
  sizes?: string;
  position?: string;
  className?: string;
  lazy?: boolean;
  priority?: boolean;
};

const fileFor = (name: string, width: Width) =>
  `/images/oak/photos/${name}${width === 1600 ? "" : `-${width}`}.webp`;

/** An OAK photo at the right size for the screen, with a tiny blurred preview until it arrives. */
export function Photo({ name, alt, phone = 800, largest = 1600, sizes = "100vw", position, className, lazy, priority }: Props) {
  const srcSet = WIDTHS.filter((width) => width >= 800 && width <= largest)
    .map((width) => `${fileFor(name, width)} ${width}w`)
    .join(", ");
  const preview = PHOTO_PREVIEWS[name];
  return (
    <picture>
      <source media="(max-width: 767px)" srcSet={fileFor(name, phone)} />
      <img
        src={fileFor(name, largest)}
        srcSet={srcSet || undefined}
        sizes={sizes}
        alt={alt}
        className={className}
        loading={lazy ? "lazy" : undefined}
        decoding="async"
        fetchPriority={priority ? "high" : undefined}
        style={{
          objectPosition: position,
          backgroundImage: preview ? `url("${preview}")` : undefined,
          backgroundSize: "cover",
          backgroundPosition: position ?? "center",
        }}
      />
    </picture>
  );
}
