import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { startLogin } from "@/const";
import { OakLogo } from "./OakLogo";

/** The sign-in screen every OAK app shares. `children` holds anything an app adds below the button. */
export function OakSignIn({
  title = "Welcome back",
  description = "Sign in to run your shop, your orders and your customers.",
  photo = "merchant-shop",
  alt = "A shopkeeper at the counter of her store",
  children,
}: {
  photo?: string;
  alt?: string;
  title?: string;
  description?: string;
  children?: ReactNode;
}) {
  return (
    <div className="min-h-screen grid lg:grid-cols-2 bg-background">
      <div className="flex flex-col justify-between p-8 sm:p-12">
        <OakLogo />
        <div className="w-full max-w-sm py-16">
          <h1 className="oak-display text-4xl text-foreground">{title}</h1>
          <p className="mt-3 text-muted-foreground">{description}</p>
          <Button onClick={() => startLogin()} size="lg" className="mt-8 w-full">
            Sign in
          </Button>
          {children}
        </div>
        <p className="oak-eyebrow text-muted-foreground">Oja · Ahia · Kasuwa</p>
      </div>
      <div className="relative hidden lg:block">
        <img src={`/images/oak/photos/${photo}.webp`} alt={alt} className="absolute inset-0 h-full w-full object-cover" />
        <div className="oak-weave-band absolute inset-x-0 bottom-0 !h-3" />
      </div>
    </div>
  );
}
