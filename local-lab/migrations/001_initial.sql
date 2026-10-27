CREATE TABLE deliveries (
 id uuid PRIMARY KEY,
 channel text NOT NULL CHECK (channel = 'green-api'),
 target text NOT NULL,
 date text NOT NULL CHECK (date ~ '^\d{4}-\d{2}-\d{2}$'),
 payload text NOT NULL CHECK (length(payload) BETWEEN 1 AND 20000),
 payload_hash text NOT NULL CHECK (payload_hash ~ '^[a-f0-9]{64}$'),
 status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','unknown','accepted','confirmed','failed')),
 attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 1),
 provider_id text,
 evidence text NOT NULL DEFAULT 'created',
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(channel,target,date),
 UNIQUE(channel,provider_id),
 CHECK ((status IN ('accepted','confirmed','failed')) = (provider_id IS NOT NULL)),
 CHECK (provider_id IS NULL OR length(provider_id) > 0),
 CHECK ((status = 'pending') = (attempts = 0))
);
CREATE TABLE delivery_evidence (
 delivery_id uuid NOT NULL REFERENCES deliveries(id),
 attempt integer NOT NULL,
 fact text NOT NULL,
 recorded_at timestamptz NOT NULL DEFAULT now()
);
CREATE FUNCTION preserve_delivery() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (NEW.id,NEW.channel,NEW.target,NEW.date,NEW.payload,NEW.payload_hash,NEW.created_at)
 IS DISTINCT FROM (OLD.id,OLD.channel,OLD.target,OLD.date,OLD.payload,OLD.payload_hash,OLD.created_at) THEN
 RAISE EXCEPTION 'daily payload is immutable';
 END IF;
 IF NEW.status <> OLD.status AND NOT (
  (OLD.status = 'pending' AND NEW.status = 'unknown') OR
  (OLD.status = 'unknown' AND NEW.status = 'accepted') OR
  (OLD.status = 'accepted' AND NEW.status IN ('confirmed','failed'))
 ) THEN RAISE EXCEPTION 'illegal delivery transition'; END IF;
 IF OLD.provider_id IS NOT NULL AND NEW.provider_id IS DISTINCT FROM OLD.provider_id THEN
 RAISE EXCEPTION 'provider identity is immutable'; END IF;
 NEW.updated_at := now();
 RETURN NEW;
END $$;
CREATE TRIGGER immutable_delivery BEFORE UPDATE ON deliveries FOR EACH ROW EXECUTE FUNCTION preserve_delivery();
CREATE FUNCTION record_delivery_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO delivery_evidence(delivery_id,attempt,fact) VALUES(NEW.id,NEW.attempts,NEW.evidence);
 RETURN NEW;
END $$;
CREATE TRIGGER delivery_evidence AFTER INSERT OR UPDATE ON deliveries FOR EACH ROW EXECUTE FUNCTION record_delivery_evidence();
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='gospel_runtime') THEN
  GRANT SELECT ON deliveries,delivery_evidence,schema_migrations TO gospel_runtime;
  GRANT INSERT ON deliveries,delivery_evidence TO gospel_runtime;
  GRANT UPDATE(status,attempts,provider_id,evidence) ON deliveries TO gospel_runtime;
 END IF;
 IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='gospel_status') THEN
  GRANT SELECT ON deliveries,delivery_evidence,schema_migrations TO gospel_status;
 END IF;
END $$;
