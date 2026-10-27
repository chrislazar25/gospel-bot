CREATE TABLE deliveries (
 id uuid PRIMARY KEY,
 channel text NOT NULL CHECK (channel = 'simulator'),
 target text NOT NULL CHECK (target = 'synthetic-prayer-group'),
 date text NOT NULL,
 payload text NOT NULL,
 payload_hash text NOT NULL,
 status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','unknown','accepted','confirmed')),
 attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
 provider_id uuid,
 evidence text NOT NULL DEFAULT 'created',
 UNIQUE(channel,target,date),
 CHECK ((status IN ('accepted','confirmed')) = (provider_id IS NOT NULL))
);
CREATE TABLE delivery_evidence (delivery_id uuid REFERENCES deliveries(id), attempt integer NOT NULL, fact text NOT NULL, recorded_at timestamptz NOT NULL DEFAULT now());
CREATE FUNCTION preserve_delivery_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (NEW.id,NEW.channel,NEW.target,NEW.date,NEW.payload,NEW.payload_hash)
 IS DISTINCT FROM (OLD.id,OLD.channel,OLD.target,OLD.date,OLD.payload,OLD.payload_hash) THEN
 RAISE EXCEPTION 'daily payload is immutable';
 END IF;
 IF OLD.status = 'confirmed' AND NEW.status <> 'confirmed' THEN
 RAISE EXCEPTION 'confirmed is terminal';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER immutable_delivery BEFORE UPDATE ON deliveries FOR EACH ROW EXECUTE FUNCTION preserve_delivery_identity();
CREATE FUNCTION record_delivery_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO delivery_evidence(delivery_id,attempt,fact) VALUES(NEW.id,NEW.attempts,NEW.evidence);
 RETURN NEW;
END $$;
CREATE TRIGGER delivery_evidence AFTER INSERT OR UPDATE ON deliveries FOR EACH ROW EXECUTE FUNCTION record_delivery_evidence();
CREATE SCHEMA simulator;
CREATE TABLE simulator.control (singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton), mode text NOT NULL);
INSERT INTO simulator.control VALUES (true,'success');
CREATE TABLE simulator.requests (id uuid PRIMARY KEY, target text NOT NULL, payload text NOT NULL, accepted boolean NOT NULL, receipt text NOT NULL DEFAULT 'sent');
