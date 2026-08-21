-- Adds photo storage for the Yandex.Disk lot-photos feature.
-- See docs/yandex-disk-photos-feed.md.

BEGIN;

ALTER TABLE "lots" ADD COLUMN "feed_image_urls" TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE "lots" ADD COLUMN "photos" TEXT[] NOT NULL DEFAULT '{}';

COMMIT;
