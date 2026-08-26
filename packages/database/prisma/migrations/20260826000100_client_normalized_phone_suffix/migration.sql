-- Supports bounded same-phone safety checks across historical +7/8/10/12-digit formatting.
CREATE INDEX "clients_normalized_phone_suffix_idx"
ON "clients" ((right(regexp_replace("phone", '[^0-9]', '', 'g'), 10)));
