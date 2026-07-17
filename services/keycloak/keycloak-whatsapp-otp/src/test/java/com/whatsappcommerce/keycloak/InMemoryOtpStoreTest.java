package com.whatsappcommerce.keycloak;

import com.whatsappcommerce.keycloak.otp.InMemoryOtpStore;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.*;

class InMemoryOtpStoreTest {

    private InMemoryOtpStore store;

    @BeforeEach
    void setUp() {
        store = new InMemoryOtpStore();
    }

    @Test
    void storeAndRetrieveOtp() {
        store.store("+2348012345678", "123456", 300);
        assertEquals("123456", store.get("+2348012345678"));
    }

    @Test
    void getReturnsNullForUnknownPhone() {
        assertNull(store.get("+2349999999999"));
    }

    @Test
    void deleteRemovesOtp() {
        store.store("+2348012345678", "654321", 300);
        store.delete("+2348012345678");
        assertNull(store.get("+2348012345678"));
    }

    @Test
    void expiredOtpReturnsNull() throws InterruptedException {
        store.store("+2348012345678", "999999", 1); // 1 second TTL
        Thread.sleep(1100); // Wait for expiry
        assertNull(store.get("+2348012345678"), "Expired OTP should return null");
    }

    @Test
    void normalisesPhoneWithSpacesAndDashes() {
        store.store("+234 801-234-5678", "111111", 300);
        // Should be retrievable with normalised form
        assertEquals("111111", store.get("+2348012345678"));
    }

    @Test
    void overwritesExistingOtp() {
        store.store("+2348012345678", "111111", 300);
        store.store("+2348012345678", "222222", 300);
        assertEquals("222222", store.get("+2348012345678"));
    }
}
