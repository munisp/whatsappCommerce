package com.whatsappcommerce.keycloak.authenticator;

import com.whatsappcommerce.keycloak.config.WhatsAppOtpConstants;
import org.keycloak.Config;
import org.keycloak.authentication.Authenticator;
import org.keycloak.authentication.AuthenticatorFactory;
import org.keycloak.models.AuthenticationExecutionModel;
import org.keycloak.models.KeycloakSession;
import org.keycloak.models.KeycloakSessionFactory;
import org.keycloak.provider.ProviderConfigProperty;

import java.util.List;

/**
 * Factory for the WhatsApp OTP Authenticator SPI.
 * Registers the provider with Keycloak and declares its configurable properties.
 */
public class WhatsAppOtpAuthenticatorFactory implements AuthenticatorFactory {

    private static final WhatsAppOtpAuthenticator SINGLETON = new WhatsAppOtpAuthenticator();

    private static final AuthenticationExecutionModel.Requirement[] REQUIREMENT_CHOICES = {
            AuthenticationExecutionModel.Requirement.REQUIRED,
            AuthenticationExecutionModel.Requirement.ALTERNATIVE,
            AuthenticationExecutionModel.Requirement.DISABLED
    };

    @Override
    public String getId() {
        return WhatsAppOtpConstants.PROVIDER_ID;
    }

    @Override
    public String getDisplayType() {
        return "WhatsApp OTP";
    }

    @Override
    public String getHelpText() {
        return "Sends a 6-digit OTP to the user's WhatsApp number via the WhatsApp Business Cloud API. "
                + "Supports both passwordless (phone as identity) and MFA (second factor) modes.";
    }

    @Override
    public String getReferenceCategory() {
        return "otp";
    }

    @Override
    public boolean isConfigurable() {
        return true;
    }

    @Override
    public boolean isUserSetupAllowed() {
        return false;
    }

    @Override
    public AuthenticationExecutionModel.Requirement[] getRequirementChoices() {
        return REQUIREMENT_CHOICES;
    }

    @Override
    public List<ProviderConfigProperty> getConfigProperties() {
        return List.of(
                new ProviderConfigProperty(
                        WhatsAppOtpConstants.CFG_WHATSAPP_TOKEN,
                        "WhatsApp Access Token",
                        "WhatsApp Business Cloud API access token (Bearer). "
                                + "Can also be set via WAC_WHATSAPP_TOKEN environment variable.",
                        ProviderConfigProperty.PASSWORD,
                        ""),
                new ProviderConfigProperty(
                        WhatsAppOtpConstants.CFG_WHATSAPP_PHONE_ID,
                        "WhatsApp Phone Number ID",
                        "The phone number ID from your WhatsApp Business account "
                                + "(Meta Business Manager → WhatsApp → Phone Numbers). "
                                + "Can also be set via WAC_WHATSAPP_PHONE_ID environment variable.",
                        ProviderConfigProperty.STRING_TYPE,
                        ""),
                new ProviderConfigProperty(
                        WhatsAppOtpConstants.CFG_TEMPLATE_NAME,
                        "Message Template Name",
                        "Name of the approved WhatsApp message template (AUTHENTICATION category). "
                                + "Default: wac_otp",
                        ProviderConfigProperty.STRING_TYPE,
                        WhatsAppOtpConstants.DEFAULT_TEMPLATE_NAME),
                new ProviderConfigProperty(
                        WhatsAppOtpConstants.CFG_TEMPLATE_LANG,
                        "Template Language Code",
                        "Language code for the message template (e.g., en_US, yo_NG, ha_NG). "
                                + "Default: en_US",
                        ProviderConfigProperty.STRING_TYPE,
                        WhatsAppOtpConstants.DEFAULT_TEMPLATE_LANG),
                new ProviderConfigProperty(
                        WhatsAppOtpConstants.CFG_OTP_TTL_SECONDS,
                        "OTP Time-to-Live (seconds)",
                        "How long the OTP is valid after sending. Default: 300 (5 minutes).",
                        ProviderConfigProperty.STRING_TYPE,
                        String.valueOf(WhatsAppOtpConstants.DEFAULT_OTP_TTL_SECONDS)),
                new ProviderConfigProperty(
                        WhatsAppOtpConstants.CFG_MAX_ATTEMPTS,
                        "Maximum OTP Attempts",
                        "Number of incorrect OTP attempts before the session is invalidated. Default: 3.",
                        ProviderConfigProperty.STRING_TYPE,
                        String.valueOf(WhatsAppOtpConstants.DEFAULT_MAX_ATTEMPTS)),
                new ProviderConfigProperty(
                        WhatsAppOtpConstants.CFG_REDIS_ENABLED,
                        "Use Redis OTP Store",
                        "Enable Redis-backed OTP store for clustered deployments. "
                                + "Requires WAC_REDIS_HOST, WAC_REDIS_PORT, WAC_REDIS_PASSWORD env vars. "
                                + "Default: false (uses in-memory store, single-node only).",
                        ProviderConfigProperty.BOOLEAN_TYPE,
                        "false"),
                new ProviderConfigProperty(
                        WhatsAppOtpConstants.CFG_SIMULATION_MODE,
                        "Simulation Mode",
                        "In simulation mode, OTPs are logged to the server console instead of being "
                                + "sent via WhatsApp. Use for development and testing only.",
                        ProviderConfigProperty.BOOLEAN_TYPE,
                        "false")
        );
    }

    @Override
    public Authenticator create(KeycloakSession session) {
        return SINGLETON;
    }

    @Override
    public void init(Config.Scope config) {}

    @Override
    public void postInit(KeycloakSessionFactory factory) {}

    @Override
    public void close() {}
}
