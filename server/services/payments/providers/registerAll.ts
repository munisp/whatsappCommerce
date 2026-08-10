import { registerProvider } from './registry';
import { flutterwaveProvider } from './flutterwave';
import { stripeProvider } from './stripe';
import { monnifyProvider } from './monnify';

/**
 * Adapter pack registration. The server bootstrap should call
 * `registerAdapterPack()` once after the provider core is initialized.
 * Safe to call multiple times — duplicate registrations are skipped.
 */
let registered = false;

export function registerAdapterPack(): void {
  if (registered) return;
  registered = true;
  for (const p of [flutterwaveProvider, stripeProvider, monnifyProvider]) {
    try {
      registerProvider(p);
    } catch {
      // Duplicate or registry-not-ready: skip without failing boot.
    }
  }
}
