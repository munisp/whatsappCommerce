package com.whatsappcommerce.keycloak;

import com.whatsappcommerce.keycloak.otp.OtpGenerator;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.RepeatedTest;

import java.util.HashSet;
import java.util.Set;

import static org.junit.jupiter.api.Assertions.*;

class OtpGeneratorTest {

    @Test
    void generateReturns6DigitString() {
        String otp = OtpGenerator.generate();
        assertNotNull(otp);
        assertEquals(6, otp.length(), "OTP must be exactly 6 digits");
        assertTrue(otp.matches("[0-9]{6}"), "OTP must contain only digits");
    }

    @Test
    void generateZeroPadsShortNumbers() {
        // Run 1000 times to ensure we get zero-padded values
        boolean foundZeroPadded = false;
        for (int i = 0; i < 1000; i++) {
            String otp = OtpGenerator.generate();
            assertEquals(6, otp.length());
            if (otp.startsWith("0")) {
                foundZeroPadded = true;
                break;
            }
        }
        // Statistically, in 1000 runs, we should see at least one zero-padded OTP
        // (probability of never seeing one is (0.9)^1000 ≈ 2.6e-46)
        assertTrue(foundZeroPadded, "Should produce zero-padded OTPs");
    }

    @RepeatedTest(5)
    void generateProducesUniqueValues() {
        Set<String> otps = new HashSet<>();
        for (int i = 0; i < 100; i++) {
            otps.add(OtpGenerator.generate());
        }
        // With 100 random 6-digit OTPs, we expect high uniqueness (birthday paradox: ~0.5% collision)
        assertTrue(otps.size() > 90, "Expected mostly unique OTPs, got: " + otps.size());
    }
}
