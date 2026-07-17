package com.whatsappcommerce.keycloak.otp;

/**
 * Contract for OTP storage. Two implementations are provided:
 * - InMemoryOtpStore: for single-node / development deployments
 * - RedisOtpStore: for clustered / production deployments
 */
public interface OtpStore {

    /**
     * Store an OTP for a given phone number with a TTL in seconds.
     */
    void store(String phone, String otp, int ttlSeconds);

    /**
     * Retrieve the stored OTP for a phone number, or null if expired/missing.
     */
    String get(String phone);

    /**
     * Delete the OTP after successful verification (one-time use).
     */
    void delete(String phone);
}
