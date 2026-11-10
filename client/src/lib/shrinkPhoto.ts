/**
 * Phone photos are often 4–8 MB, and the server refuses JSON bodies over 2 MB: shrink to ~1600px JPEG (a few
 * hundred KB) before sending. Used by the rider page and the driver app's handover.
 */
function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

/** Phone photos are often 4–8 MB; shrink to ~1600px JPEG before sending. */
export async function shrinkPhoto(file: File): Promise<{ dataUrl: string; type: string }> {
  const original = await readAsDataUrl(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image(); i.onload = () => resolve(i); i.onerror = reject; i.src = original;
    });
    const scale = Math.min(1, 1600 / Math.max(img.width, img.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(img.width * scale); canvas.height = Math.round(img.height * scale);
    canvas.getContext("2d")!.drawImage(img, 0, 0, canvas.width, canvas.height);
    return { dataUrl: canvas.toDataURL("image/jpeg", 0.82), type: "image/jpeg" };
  } catch {
    return { dataUrl: original, type: file.type || "image/jpeg" };
  }
}

