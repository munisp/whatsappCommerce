# syntax=docker/dockerfile:1
FROM quay.io/keycloak/keycloak:26.1 AS builder
ENV KC_FEATURES=organization,token-exchange,fine-grained-admin-permissions
ENV KC_DB=postgres
ADD https://github.com/SnuK87/keycloak-kafka/releases/download/1.2.0/keycloak-kafka-1.2.0-jar-with-dependencies.jar \
    /opt/keycloak/providers/keycloak-kafka.jar
COPY themes/whatsapp-commerce /opt/keycloak/themes/whatsapp-commerce
COPY config/realm-export.json /opt/keycloak/data/import/realm-export.json
RUN /opt/keycloak/bin/kc.sh build

FROM quay.io/keycloak/keycloak:26.1
COPY --from=builder /opt/keycloak /opt/keycloak
RUN mkdir -p /opt/keycloak/certs
VOLUME ["/opt/keycloak/certs"]
EXPOSE 8080 8443
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=5 \
    CMD curl -sf http://localhost:8080/health/ready || exit 1
ENTRYPOINT ["/opt/keycloak/bin/kc.sh"]
CMD ["start", "--import-realm"]
