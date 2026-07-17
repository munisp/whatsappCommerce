<#import "template.ftl" as layout>
<@layout.registrationLayout displayInfo=true; section>
    <#if section = "header">
        ${msg("whatsappOtpVerifyTitle")}
    <#elseif section = "form">
        <form id="kc-otp-entry-form" class="${properties.kcFormClass!}" action="${url.loginAction}" method="post">
            <div class="${properties.kcFormGroupClass!}">
                <p class="wac-otp-sent-msg">
                    ${msg("whatsappOtpSentTo", maskedPhone!'')}
                </p>

                <label for="otp" class="${properties.kcLabelClass!}">
                    ${msg("whatsappOtpCodeLabel")}
                </label>
                <input
                    type="text"
                    id="otp"
                    name="otp"
                    class="${properties.kcInputClass!} wac-otp-input"
                    placeholder="000000"
                    autofocus
                    autocomplete="one-time-code"
                    inputmode="numeric"
                    pattern="[0-9]{6}"
                    maxlength="6"
                    required
                />
                <#if message?has_content>
                    <span class="${properties.kcInputErrorMessageClass!}" aria-live="polite">
                        ${kcSanitize(msg(message.summary))?no_esc}
                    </span>
                </#if>
            </div>

            <div class="${properties.kcFormGroupClass!}">
                <div id="kc-form-buttons" class="${properties.kcFormButtonsClass!}">
                    <input
                        class="${properties.kcButtonClass!} ${properties.kcButtonPrimaryClass!} ${properties.kcButtonBlockClass!} ${properties.kcButtonLargeClass!}"
                        name="login"
                        id="kc-login"
                        type="submit"
                        value="${msg("whatsappOtpVerifyCode")}"
                    />
                </div>
            </div>

            <div class="wac-resend-section">
                <a href="${url.loginRestartFlowUrl}" class="wac-resend-link">
                    ${msg("whatsappOtpResend")}
                </a>
            </div>
        </form>
    <#elseif section = "info">
        <div class="wac-info-box">
            <p>${msg("whatsappOtpVerifyInfo")}</p>
        </div>
    </#if>
</@layout.registrationLayout>
