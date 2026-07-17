<#import "template.ftl" as layout>
<@layout.registrationLayout displayInfo=true; section>
    <#if section = "header">
        ${msg("whatsappOtpPhoneTitle")}
    <#elseif section = "form">
        <form id="kc-phone-entry-form" class="${properties.kcFormClass!}" action="${url.loginAction}" method="post">
            <div class="${properties.kcFormGroupClass!}">
                <label for="phone" class="${properties.kcLabelClass!}">
                    ${msg("whatsappOtpPhoneLabel")}
                </label>
                <div class="wac-phone-input-group">
                    <span class="wac-phone-prefix">
                        <img src="${url.resourcesPath}/img/whatsapp-icon.svg" alt="WhatsApp" width="20" height="20" />
                    </span>
                    <input
                        type="tel"
                        id="phone"
                        name="phone"
                        class="${properties.kcInputClass!} wac-phone-input"
                        placeholder="+234 801 234 5678"
                        value="${existingPhone!''}"
                        autofocus
                        autocomplete="tel"
                        inputmode="tel"
                        pattern="[+]?[0-9\s\-()]{8,16}"
                        required
                    />
                </div>
                <#if message?has_content>
                    <span class="${properties.kcInputErrorMessageClass!}" aria-live="polite">
                        ${kcSanitize(msg(message.summary))?no_esc}
                    </span>
                </#if>
                <span class="wac-phone-hint">${msg("whatsappOtpPhoneHint")}</span>
            </div>

            <div class="${properties.kcFormGroupClass!}">
                <div id="kc-form-buttons" class="${properties.kcFormButtonsClass!}">
                    <input
                        class="${properties.kcButtonClass!} ${properties.kcButtonPrimaryClass!} ${properties.kcButtonBlockClass!} ${properties.kcButtonLargeClass!}"
                        name="login"
                        id="kc-login"
                        type="submit"
                        value="${msg("whatsappOtpSendCode")}"
                    />
                </div>
            </div>
        </form>
    <#elseif section = "info">
        <div class="wac-info-box">
            <p>${msg("whatsappOtpPhoneInfo")}</p>
        </div>
    </#if>
</@layout.registrationLayout>
