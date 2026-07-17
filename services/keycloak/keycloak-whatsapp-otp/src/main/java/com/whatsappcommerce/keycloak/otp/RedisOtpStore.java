package com.whatsappcommerce.keycloak.otp;

import redis.clients.jedis.Jedis;
import redis.clients.jedis.JedisPool;
import redis.clients.jedis.JedisPoolConfig;
import org.jboss.logging.Logger;

/**
 * Redis-backed OTP store for clustered production deployments.
 * Uses Jedis (shaded) to avoid classpath conflicts with Keycloak's own Redis usage.
 *
 * Environment variables:
 *   WAC_REDIS_HOST  (default: localhost)
 *   WAC_REDIS_PORT  (default: 6379)
 *   WAC_REDIS_PASSWORD (optional)
 */
public class RedisOtpStore implements OtpStore {

    private static final Logger LOG = Logger.getLogger(RedisOtpStore.class);
    private static final String KEY_PREFIX = "wac:otp:";

    private final JedisPool pool;

    public RedisOtpStore() {
        String host = System.getenv().getOrDefault("WAC_REDIS_HOST", "localhost");
        int port = Integer.parseInt(System.getenv().getOrDefault("WAC_REDIS_PORT", "6379"));
        String password = System.getenv("WAC_REDIS_PASSWORD");

        JedisPoolConfig config = new JedisPoolConfig();
        config.setMaxTotal(10);
        config.setMaxIdle(5);
        config.setTestOnBorrow(true);

        if (password != null && !password.isBlank()) {
            this.pool = new JedisPool(config, host, port, 2000, password);
        } else {
            this.pool = new JedisPool(config, host, port);
        }
        LOG.infof("[RedisOtpStore] Connected to Redis at %s:%d", host, port);
    }

    @Override
    public void store(String phone, String otp, int ttlSeconds) {
        try (Jedis jedis = pool.getResource()) {
            jedis.setex(KEY_PREFIX + normalise(phone), ttlSeconds, otp);
            LOG.debugf("[RedisOtpStore] Stored OTP for %s, TTL=%ds", mask(phone), ttlSeconds);
        } catch (Exception e) {
            LOG.errorf("[RedisOtpStore] Failed to store OTP for %s: %s", mask(phone), e.getMessage());
            throw new RuntimeException("Failed to store OTP in Redis", e);
        }
    }

    @Override
    public String get(String phone) {
        try (Jedis jedis = pool.getResource()) {
            String value = jedis.get(KEY_PREFIX + normalise(phone));
            if (value == null) {
                LOG.debugf("[RedisOtpStore] No OTP found for %s", mask(phone));
            }
            return value;
        } catch (Exception e) {
            LOG.errorf("[RedisOtpStore] Failed to get OTP for %s: %s", mask(phone), e.getMessage());
            return null;
        }
    }

    @Override
    public void delete(String phone) {
        try (Jedis jedis = pool.getResource()) {
            jedis.del(KEY_PREFIX + normalise(phone));
            LOG.debugf("[RedisOtpStore] Deleted OTP for %s", mask(phone));
        } catch (Exception e) {
            LOG.warnf("[RedisOtpStore] Failed to delete OTP for %s: %s", mask(phone), e.getMessage());
        }
    }

    private String normalise(String phone) {
        return phone.replaceAll("[\\s\\-()]+", "");
    }

    private String mask(String phone) {
        if (phone == null || phone.length() < 4) return "****";
        return "****" + phone.substring(phone.length() - 4);
    }
}
