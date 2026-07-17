package com.whatsappcommerce.keycloak.whatsapp;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.jboss.logging.Logger;

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;

/**
 * Sends OTP codes via the WhatsApp Business Cloud API using the
 * official OTP message template (authentication category).
 *
 * API reference: https://developers.facebook.com/docs/whatsapp/cloud-api/messages/otp-messages
 *
 * Required environment variables:
 *   WAC_WHATSAPP_TOKEN        — Bearer token (WhatsApp Business API access token)
 *   WAC_WHATSAPP_PHONE_ID     — WhatsApp Business phone number ID
 *   WAC_WHATSAPP_OTP_TEMPLATE — Template name (default: wac_otp)
 *   WAC_WHATSAPP_TEMPLATE_LANG — Template language code (default: en_US)
 */
public class WhatsAppOtpSender {

    private static final Logger LOG = Logger.getLogger(WhatsAppOtpSender.class);

    private static final String GRAPH_API_BASE = "https://graph.facebook.com/v21.0";
    private static final int TIMEOUT_SECONDS = 10;

    private final HttpClient httpClient;
    private final ObjectMapper mapper;
    private final String accessToken;
    private final String phoneNumberId;
    private final String templateName;
    private final String templateLanguage;
    private final boolean simulationMode;

    public WhatsAppOtpSender(String accessToken, String phoneNumberId,
                              String templateName, String templateLanguage,
                              boolean simulationMode) {
        this.accessToken = accessToken;
        this.phoneNumberId = phoneNumberId;
        this.templateName = templateName != null ? templateName : "wac_otp";
        this.templateLanguage = templateLanguage != null ? templateLanguage : "en_US";
        this.simulationMode = simulationMode;
        this.httpClient = HttpClient.newBuilder()
                .connectTimeout(Duration.ofSeconds(TIMEOUT_SECONDS))
                .build();
        this.mapper = new ObjectMapper();
    }

    /**
     * Send an OTP to the given phone number via WhatsApp Cloud API.
     *
     * @param toPhone E.164 phone number (e.g., +2348012345678)
     * @param otp     6-digit OTP code
     * @throws WhatsAppSendException if the API call fails
     */
    public void sendOtp(String toPhone, String otp) throws WhatsAppSendException {
        if (simulationMode) {
            LOG.infof("[WhatsApp OTP SIMULATION] Would send OTP %s to %s", otp, mask(toPhone));
            return;
        }

        String payload = buildPayload(toPhone, otp);
        String url = GRAPH_API_BASE + "/" + phoneNumberId + "/messages";

        LOG.debugf("[WhatsAppOtpSender] Sending OTP to %s via template '%s'", mask(toPhone), templateName);

        try {
            HttpRequest request = HttpRequest.newBuilder()
                    .uri(URI.create(url))
                    .header("Authorization", "Bearer " + accessToken)
                    .header("Content-Type", "application/json")
                    .POST(HttpRequest.BodyPublishers.ofString(payload))
                    .timeout(Duration.ofSeconds(TIMEOUT_SECONDS))
                    .build();

            HttpResponse<String> response = httpClient.send(request,
                    HttpResponse.BodyHandlers.ofString());

            if (response.statusCode() == 200 || response.statusCode() == 201) {
                LOG.infof("[WhatsAppOtpSender] OTP sent successfully to %s, status=%d",
                        mask(toPhone), response.statusCode());
            } else {
                LOG.errorf("[WhatsAppOtpSender] Failed to send OTP to %s: HTTP %d — %s",
                        mask(toPhone), response.statusCode(), response.body());
                throw new WhatsAppSendException(
                        "WhatsApp API returned HTTP " + response.statusCode() + ": " + response.body());
            }
        } catch (WhatsAppSendException e) {
            throw e;
        } catch (IOException | InterruptedException e) {
            Thread.currentThread().interrupt();
            LOG.errorf("[WhatsAppOtpSender] Network error sending OTP to %s: %s",
                    mask(toPhone), e.getMessage());
            throw new WhatsAppSendException("Network error sending OTP via WhatsApp: " + e.getMessage(), e);
        }
    }

    /**
     * Build the WhatsApp Cloud API JSON payload for an OTP authentication template.
     *
     * The template must be of category AUTHENTICATION and have one body parameter
     * (the OTP code) and optionally a button parameter for copy-code functionality.
     *
     * Template structure expected:
     *   Body: "Your {{1}} code is: {{1}}. Valid for 5 minutes."
     *   Button (optional): "Copy Code" with OTP as the copy_code parameter
     */
    private String buildPayload(String toPhone, String otp) {
        try {
            ObjectNode root = mapper.createObjectNode();
            root.put("messaging_product", "whatsapp");
            root.put("to", normalisePhone(toPhone));
            root.put("type", "template");

            ObjectNode template = root.putObject("template");
            template.put("name", templateName);
            template.putObject("language").put("code", templateLanguage);

            // Components: body with OTP parameter + optional copy-code button
            var components = template.putArray("components");

            // Body component
            ObjectNode bodyComp = components.addObject();
            bodyComp.put("type", "body");
            var bodyParams = bodyComp.putArray("parameters");
            ObjectNode otpParam = bodyParams.addObject();
            otpParam.put("type", "text");
            otpParam.put("text", otp);

            // Button component (copy_code) — index 0
            ObjectNode btnComp = components.addObject();
            btnComp.put("type", "button");
            btnComp.put("sub_type", "url");
            btnComp.put("index", "0");
            var btnParams = btnComp.putArray("parameters");
            ObjectNode btnParam = btnParams.addObject();
            btnParam.put("type", "text");
            btnParam.put("text", otp);

            return mapper.writeValueAsString(root);
        } catch (Exception e) {
            throw new RuntimeException("Failed to build WhatsApp OTP payload", e);
        }
    }

    private String normalisePhone(String phone) {
        // Ensure E.164 format — strip spaces, dashes, parentheses
        String normalised = phone.replaceAll("[\\s\\-()]+", "");
        if (!normalised.startsWith("+")) {
            normalised = "+" + normalised;
        }
        return normalised;
    }

    private String mask(String phone) {
        if (phone == null || phone.length() < 4) return "****";
        return "****" + phone.substring(phone.length() - 4);
    }
}
