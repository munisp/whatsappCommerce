package com.whatsappcommerce.keycloak.config;

/**
 * Shared constants for the WhatsApp OTP authenticator SPI.
 */
public final class WhatsAppOtpConstants {

    private WhatsAppOtpConstants() {}

    // Provider ID — must match the value in META-INF/services
    public static final String PROVIDER_ID = "whatsapp-otp-authenticator";

    // Auth session note keys
    public static final String AUTH_NOTE_PHONE    = "wac_otp_phone";
    public static final String AUTH_NOTE_OTP      = "wac_otp_code";
    public static final String AUTH_NOTE_TTL      = "wac_otp_ttl";
    public static final String AUTH_NOTE_ATTEMPTS = "wac_otp_attempts";

    // Authenticator config property keys
    public static final String CFG_OTP_TTL_SECONDS   = "otp_ttl_seconds";
    public static final String CFG_MAX_ATTEMPTS       = "max_attempts";
    public static final String CFG_WHATSAPP_TOKEN     = "whatsapp_access_token";
    public static final String CFG_WHATSAPP_PHONE_ID  = "whatsapp_phone_number_id";
    public static final String CFG_TEMPLATE_NAME      = "whatsapp_template_name";
    public static final String CFG_TEMPLATE_LANG      = "whatsapp_template_language";
    public static final String CFG_SIMULATION_MODE    = "simulation_mode";
    public static final String CFG_REDIS_ENABLED      = "redis_enabled";

    // Default values
    public static final int DEFAULT_OTP_TTL_SECONDS = 300;  // 5 minutes
    public static final int DEFAULT_MAX_ATTEMPTS    = 3;
    public static final String DEFAULT_TEMPLATE_NAME = "wac_otp";
    public static final String DEFAULT_TEMPLATE_LANG = "en_US";

    // User attribute key for phone number
    public static final String USER_ATTR_PHONE = "phoneNumber";

    // Form field names (must match .ftl templates)
    public static final String FORM_PHONE = "phone";
    public static final String FORM_OTP   = "otp";

    // FTL template names
    public static final String TPL_PHONE_ENTRY = "wac-phone-entry.ftl";
    public static final String TPL_OTP_ENTRY   = "wac-otp-entry.ftl";
}
