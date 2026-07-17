package com.whatsappcommerce.keycloak.authenticator;

import com.whatsappcommerce.keycloak.config.WhatsAppOtpConstants;
import com.whatsappcommerce.keycloak.otp.InMemoryOtpStore;
import com.whatsappcommerce.keycloak.otp.OtpGenerator;
import com.whatsappcommerce.keycloak.otp.OtpStore;
import com.whatsappcommerce.keycloak.otp.RedisOtpStore;
import com.whatsappcommerce.keycloak.whatsapp.WhatsAppOtpSender;
import com.whatsappcommerce.keycloak.whatsapp.WhatsAppSendException;
import org.jboss.logging.Logger;
import org.keycloak.authentication.AuthenticationFlowContext;
import org.keycloak.authentication.AuthenticationFlowError;
import org.keycloak.authentication.Authenticator;
import org.keycloak.models.AuthenticatorConfigModel;
import org.keycloak.models.KeycloakSession;
import org.keycloak.models.RealmModel;
import org.keycloak.models.UserModel;

import jakarta.ws.rs.core.MultivaluedMap;
import jakarta.ws.rs.core.Response;
import java.util.Map;

/**
 * Keycloak custom Authenticator SPI: Phone OTP via WhatsApp Business Cloud API.
 *
 * Authentication flow:
 *   Step 1 (authenticate): Show phone number entry form (wac-phone-entry.ftl)
 *   Step 2 (action — phone submitted): Generate OTP, send via WhatsApp, show OTP entry form
 *   Step 3 (action — OTP submitted): Validate OTP, grant or deny access
 *
 * This authenticator can be used in two modes:
 *   - Passwordless: replaces username/password entirely (phone is the identity)
 *   - MFA: added after username/password as a second factor
 */
public class WhatsAppOtpAuthenticator implements Authenticator {

    private static final Logger LOG = Logger.getLogger(WhatsAppOtpAuthenticator.class);

    // Lazy-initialised stores — one per JVM (Keycloak is single-process)
    private static volatile OtpStore otpStore;
    private static final Object STORE_LOCK = new Object();

    @Override
    public void authenticate(AuthenticationFlowContext context) {
        // Check if we are in the OTP verification step (phone already submitted)
        String phone = context.getAuthenticationSession().getAuthNote(WhatsAppOtpConstants.AUTH_NOTE_PHONE);
        if (phone != null && !phone.isBlank()) {
            // Already sent OTP — show OTP entry form
            showOtpForm(context, phone, null);
            return;
        }

        // Step 1: Show phone number entry form
        // If user already has a phone number attribute, pre-fill it
        UserModel user = context.getUser();
        String existingPhone = user != null
                ? user.getFirstAttribute(WhatsAppOtpConstants.USER_ATTR_PHONE)
                : null;

        Response challenge = context.form()
                .setAttribute("existingPhone", existingPhone != null ? existingPhone : "")
                .createForm(WhatsAppOtpConstants.TPL_PHONE_ENTRY);
        context.challenge(challenge);
    }

    @Override
    public void action(AuthenticationFlowContext context) {
        MultivaluedMap<String, String> formData =
                context.getHttpRequest().getDecodedFormParameters();

        String phone = context.getAuthenticationSession().getAuthNote(WhatsAppOtpConstants.AUTH_NOTE_PHONE);

        if (phone == null || phone.isBlank()) {
            // Step 2: Phone number submitted — send OTP
            handlePhoneSubmission(context, formData);
        } else {
            // Step 3: OTP submitted — validate
            handleOtpSubmission(context, formData, phone);
        }
    }

    private void handlePhoneSubmission(AuthenticationFlowContext context,
                                        MultivaluedMap<String, String> formData) {
        String phone = formData.getFirst(WhatsAppOtpConstants.FORM_PHONE);
        if (phone == null || phone.isBlank()) {
            Response challenge = context.form()
                    .setError("whatsappOtpPhoneRequired")
                    .createForm(WhatsAppOtpConstants.TPL_PHONE_ENTRY);
            context.challenge(challenge);
            return;
        }

        // Validate E.164 format
        String normalised = phone.replaceAll("[\\s\\-()]+", "");
        if (!normalised.matches("\\+?[1-9]\\d{7,14}")) {
            Response challenge = context.form()
                    .setAttribute("phone", phone)
                    .setError("whatsappOtpPhoneInvalid")
                    .createForm(WhatsAppOtpConstants.TPL_PHONE_ENTRY);
            context.challenge(challenge);
            return;
        }

        // Store phone in auth session
        context.getAuthenticationSession().setAuthNote(WhatsAppOtpConstants.AUTH_NOTE_PHONE, normalised);

        // Generate and send OTP
        String otp = OtpGenerator.generate();
        Map<String, String> cfg = getConfig(context);
        int ttl = Integer.parseInt(cfg.getOrDefault(WhatsAppOtpConstants.CFG_OTP_TTL_SECONDS,
                String.valueOf(WhatsAppOtpConstants.DEFAULT_OTP_TTL_SECONDS)));

        // Store OTP
        OtpStore store = getOtpStore(cfg);
        store.store(normalised, otp, ttl);

        // Store OTP in auth session as fallback (for single-node)
        context.getAuthenticationSession().setAuthNote(WhatsAppOtpConstants.AUTH_NOTE_OTP, otp);
        context.getAuthenticationSession().setAuthNote(WhatsAppOtpConstants.AUTH_NOTE_TTL,
                String.valueOf(System.currentTimeMillis() + (ttl * 1000L)));
        context.getAuthenticationSession().setAuthNote(WhatsAppOtpConstants.AUTH_NOTE_ATTEMPTS, "0");

        // Send OTP via WhatsApp
        try {
            WhatsAppOtpSender sender = buildSender(cfg);
            sender.sendOtp(normalised, otp);
            LOG.infof("[WhatsAppOtpAuthenticator] OTP sent to %s", mask(normalised));
        } catch (WhatsAppSendException e) {
            LOG.errorf("[WhatsAppOtpAuthenticator] Failed to send OTP: %s", e.getMessage());
            context.getAuthenticationSession().removeAuthNote(WhatsAppOtpConstants.AUTH_NOTE_PHONE);
            context.failureChallenge(AuthenticationFlowError.INTERNAL_ERROR,
                    context.form()
                            .setError("whatsappOtpSendFailed", e.getMessage())
                            .createErrorPage(Response.Status.INTERNAL_SERVER_ERROR));
            return;
        }

        // Show OTP entry form
        showOtpForm(context, normalised, null);
    }

    private void handleOtpSubmission(AuthenticationFlowContext context,
                                      MultivaluedMap<String, String> formData,
                                      String phone) {
        String enteredOtp = formData.getFirst(WhatsAppOtpConstants.FORM_OTP);
        if (enteredOtp == null || enteredOtp.isBlank()) {
            showOtpForm(context, phone, "whatsappOtpRequired");
            return;
        }

        Map<String, String> cfg = getConfig(context);
        int maxAttempts = Integer.parseInt(cfg.getOrDefault(
                WhatsAppOtpConstants.CFG_MAX_ATTEMPTS,
                String.valueOf(WhatsAppOtpConstants.DEFAULT_MAX_ATTEMPTS)));

        // Check attempt count
        int attempts = Integer.parseInt(
                context.getAuthenticationSession().getAuthNote(WhatsAppOtpConstants.AUTH_NOTE_ATTEMPTS) != null
                        ? context.getAuthenticationSession().getAuthNote(WhatsAppOtpConstants.AUTH_NOTE_ATTEMPTS)
                        : "0");

        if (attempts >= maxAttempts) {
            LOG.warnf("[WhatsAppOtpAuthenticator] Max attempts exceeded for %s", mask(phone));
            context.getAuthenticationSession().removeAuthNote(WhatsAppOtpConstants.AUTH_NOTE_PHONE);
            context.failureChallenge(AuthenticationFlowError.ACCESS_DENIED,
                    context.form()
                            .setError("whatsappOtpMaxAttemptsExceeded")
                            .createErrorPage(Response.Status.FORBIDDEN));
            return;
        }

        // Validate TTL
        String ttlStr = context.getAuthenticationSession().getAuthNote(WhatsAppOtpConstants.AUTH_NOTE_TTL);
        if (ttlStr != null && System.currentTimeMillis() > Long.parseLong(ttlStr)) {
            LOG.infof("[WhatsAppOtpAuthenticator] OTP expired for %s", mask(phone));
            context.getAuthenticationSession().removeAuthNote(WhatsAppOtpConstants.AUTH_NOTE_PHONE);
            context.failureChallenge(AuthenticationFlowError.EXPIRED_CODE,
                    context.form()
                            .setError("whatsappOtpExpired")
                            .createForm(WhatsAppOtpConstants.TPL_PHONE_ENTRY));
            return;
        }

        // Validate OTP — check auth session first, then OTP store
        String storedOtp = context.getAuthenticationSession().getAuthNote(WhatsAppOtpConstants.AUTH_NOTE_OTP);
        if (storedOtp == null) {
            storedOtp = getOtpStore(cfg).get(phone);
        }

        if (storedOtp == null) {
            LOG.warnf("[WhatsAppOtpAuthenticator] No OTP found in store for %s", mask(phone));
            context.getAuthenticationSession().removeAuthNote(WhatsAppOtpConstants.AUTH_NOTE_PHONE);
            context.failureChallenge(AuthenticationFlowError.EXPIRED_CODE,
                    context.form()
                            .setError("whatsappOtpExpired")
                            .createForm(WhatsAppOtpConstants.TPL_PHONE_ENTRY));
            return;
        }

        if (!storedOtp.equals(enteredOtp.trim())) {
            // Increment attempt counter
            context.getAuthenticationSession().setAuthNote(
                    WhatsAppOtpConstants.AUTH_NOTE_ATTEMPTS, String.valueOf(attempts + 1));
            LOG.infof("[WhatsAppOtpAuthenticator] Invalid OTP for %s (attempt %d/%d)",
                    mask(phone), attempts + 1, maxAttempts);
            showOtpForm(context, phone, "whatsappOtpInvalid");
            return;
        }

        // OTP is valid — clean up and succeed
        getOtpStore(cfg).delete(phone);
        context.getAuthenticationSession().removeAuthNote(WhatsAppOtpConstants.AUTH_NOTE_OTP);
        context.getAuthenticationSession().removeAuthNote(WhatsAppOtpConstants.AUTH_NOTE_TTL);
        context.getAuthenticationSession().removeAuthNote(WhatsAppOtpConstants.AUTH_NOTE_ATTEMPTS);

        // If user is not yet resolved (passwordless mode), find or create user by phone
        if (context.getUser() == null) {
            resolveUserByPhone(context, phone);
        } else {
            LOG.infof("[WhatsAppOtpAuthenticator] OTP verified for %s (MFA mode)", mask(phone));
            context.success();
        }
    }

    private void resolveUserByPhone(AuthenticationFlowContext context, String phone) {
        // Find user by phoneNumber attribute
        var users = context.getSession().users()
                .searchForUserByUserAttributeStream(context.getRealm(),
                        WhatsAppOtpConstants.USER_ATTR_PHONE, phone)
                .toList();

        if (users.size() == 1) {
            context.setUser(users.get(0));
            LOG.infof("[WhatsAppOtpAuthenticator] Resolved user %s by phone %s",
                    users.get(0).getUsername(), mask(phone));
            context.success();
        } else if (users.isEmpty()) {
            LOG.warnf("[WhatsAppOtpAuthenticator] No user found for phone %s", mask(phone));
            context.failureChallenge(AuthenticationFlowError.INVALID_USER,
                    context.form()
                            .setError("whatsappOtpUserNotFound")
                            .createErrorPage(Response.Status.UNAUTHORIZED));
        } else {
            LOG.warnf("[WhatsAppOtpAuthenticator] Multiple users found for phone %s", mask(phone));
            context.failureChallenge(AuthenticationFlowError.INVALID_USER,
                    context.form()
                            .setError("whatsappOtpAmbiguousUser")
                            .createErrorPage(Response.Status.UNAUTHORIZED));
        }
    }

    private void showOtpForm(AuthenticationFlowContext context, String phone, String error) {
        var form = context.form()
                .setAttribute("phone", phone)
                .setAttribute("maskedPhone", mask(phone));
        if (error != null) {
            form.setError(error);
        }
        context.challenge(form.createForm(WhatsAppOtpConstants.TPL_OTP_ENTRY));
    }

    private OtpStore getOtpStore(Map<String, String> cfg) {
        if (otpStore == null) {
            synchronized (STORE_LOCK) {
                if (otpStore == null) {
                    boolean redisEnabled = Boolean.parseBoolean(
                            cfg.getOrDefault(WhatsAppOtpConstants.CFG_REDIS_ENABLED, "false"));
                    otpStore = redisEnabled ? new RedisOtpStore() : new InMemoryOtpStore();
                    LOG.infof("[WhatsAppOtpAuthenticator] Using %s OTP store",
                            redisEnabled ? "Redis" : "InMemory");
                }
            }
        }
        return otpStore;
    }

    private WhatsAppOtpSender buildSender(Map<String, String> cfg) {
        String token = cfg.getOrDefault(WhatsAppOtpConstants.CFG_WHATSAPP_TOKEN,
                System.getenv().getOrDefault("WAC_WHATSAPP_TOKEN", ""));
        String phoneId = cfg.getOrDefault(WhatsAppOtpConstants.CFG_WHATSAPP_PHONE_ID,
                System.getenv().getOrDefault("WAC_WHATSAPP_PHONE_ID", ""));
        String templateName = cfg.getOrDefault(WhatsAppOtpConstants.CFG_TEMPLATE_NAME,
                WhatsAppOtpConstants.DEFAULT_TEMPLATE_NAME);
        String templateLang = cfg.getOrDefault(WhatsAppOtpConstants.CFG_TEMPLATE_LANG,
                WhatsAppOtpConstants.DEFAULT_TEMPLATE_LANG);
        boolean simulation = Boolean.parseBoolean(
                cfg.getOrDefault(WhatsAppOtpConstants.CFG_SIMULATION_MODE, "false"));
        return new WhatsAppOtpSender(token, phoneId, templateName, templateLang, simulation);
    }

    private Map<String, String> getConfig(AuthenticationFlowContext context) {
        AuthenticatorConfigModel config = context.getAuthenticatorConfig();
        return config != null && config.getConfig() != null ? config.getConfig() : Map.of();
    }

    private String mask(String phone) {
        if (phone == null || phone.length() < 4) return "****";
        return "****" + phone.substring(phone.length() - 4);
    }

    @Override
    public boolean requiresUser() {
        // false = can be used passwordless (user resolved by phone)
        return false;
    }

    @Override
    public boolean configuredFor(KeycloakSession session, RealmModel realm, UserModel user) {
        return true;
    }

    @Override
    public void setRequiredActions(KeycloakSession session, RealmModel realm, UserModel user) {
        // No required actions needed
    }

    @Override
    public void close() {}
}
