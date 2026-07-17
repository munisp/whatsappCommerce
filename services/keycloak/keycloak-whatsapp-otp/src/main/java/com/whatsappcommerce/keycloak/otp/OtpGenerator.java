package com.whatsappcommerce.keycloak.otp;

import java.security.SecureRandom;

/**
 * Cryptographically secure 6-digit OTP generator.
 * Uses SecureRandom to prevent predictable OTPs.
 */
public class OtpGenerator {

    private static final SecureRandom SECURE_RANDOM = new SecureRandom();
    private static final int OTP_LENGTH = 6;

    private OtpGenerator() {}

    /**
     * Generate a 6-digit numeric OTP string (zero-padded).
     */
    public static String generate() {
        int bound = (int) Math.pow(10, OTP_LENGTH);
        int otp = SECURE_RANDOM.nextInt(bound);
        return String.format("%0" + OTP_LENGTH + "d", otp);
    }
}
