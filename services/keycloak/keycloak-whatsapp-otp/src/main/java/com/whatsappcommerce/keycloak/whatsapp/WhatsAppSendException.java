package com.whatsappcommerce.keycloak.whatsapp;

public class WhatsAppSendException extends Exception {
    public WhatsAppSendException(String message) {
        super(message);
    }
    public WhatsAppSendException(String message, Throwable cause) {
        super(message, cause);
    }
}
