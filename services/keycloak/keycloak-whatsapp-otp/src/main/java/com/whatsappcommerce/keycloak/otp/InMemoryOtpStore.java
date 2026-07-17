package com.whatsappcommerce.keycloak.otp;

import org.jboss.logging.Logger;

import java.util.concurrent.ConcurrentHashMap;

/**
 * In-memory OTP store backed by a ConcurrentHashMap with expiry tracking.
 * Suitable for single-node development deployments.
 * For clustered production deployments, use RedisOtpStore.
 */
public class InMemoryOtpStore implements OtpStore {

    private static final Logger LOG = Logger.getLogger(InMemoryOtpStore.class);

    private record OtpEntry(String otp, long expiresAt) {}

    private final ConcurrentHashMap<String, OtpEntry> store = new ConcurrentHashMap<>();

    @Override
    public void store(String phone, String otp, int ttlSeconds) {
        long expiresAt = System.currentTimeMillis() + (ttlSeconds * 1000L);
        store.put(normalise(phone), new OtpEntry(otp, expiresAt));
        LOG.debugf("[InMemoryOtpStore] Stored OTP for %s, expires in %ds", mask(phone), ttlSeconds);
    }

    @Override
    public String get(String phone) {
        OtpEntry entry = store.get(normalise(phone));
        if (entry == null) {
            LOG.debugf("[InMemoryOtpStore] No OTP found for %s", mask(phone));
            return null;
        }
        if (System.currentTimeMillis() > entry.expiresAt()) {
            store.remove(normalise(phone));
            LOG.debugf("[InMemoryOtpStore] OTP expired for %s", mask(phone));
            return null;
        }
        return entry.otp();
    }

    @Override
    public void delete(String phone) {
        store.remove(normalise(phone));
        LOG.debugf("[InMemoryOtpStore] Deleted OTP for %s", mask(phone));
    }

    /** Normalise phone to E.164 format (strip spaces, dashes, parentheses). */
    private String normalise(String phone) {
        return phone.replaceAll("[\\s\\-()]+", "");
    }

    /** Mask phone for logging (show only last 4 digits). */
    private String mask(String phone) {
        if (phone == null || phone.length() < 4) return "****";
        return "****" + phone.substring(phone.length() - 4);
    }
}
