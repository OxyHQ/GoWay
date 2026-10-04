-- oxy:deploy-phase=post
DROP INDEX "places_claims_brand_idx";--> statement-breakpoint
ALTER TABLE "places_claims" DROP COLUMN "brand_id";