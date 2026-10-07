-- Baseline schema for PixelPro Max.
--
-- Startup runs `prisma migrate deploy`, so this file IS the schema. It is
-- generated from schema.prisma via:
--   prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script
-- Regenerate it the same way if the baseline ever needs to change, and add
-- forward migrations rather than editing this file once any database has it
-- applied.
--
-- Do NOT swap this for `prisma db push --accept-data-loss` on container start:
-- push reconciles the database against schema.prisma directly and never reads
-- the migration history, which lets the migrations rot unnoticed.
--
-- Note the UsageCounter unique index at the bottom: usage.server.js addresses
-- that table through the compound `shop_period` key and depends on the index to
-- make reserve/refund atomic. Without it every quota read fails.

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "isOnline" BOOLEAN NOT NULL DEFAULT false,
    "scope" TEXT,
    "expires" TIMESTAMP(3),
    "accessToken" TEXT NOT NULL,
    "userId" BIGINT,
    "firstName" TEXT,
    "lastName" TEXT,
    "email" TEXT,
    "accountOwner" BOOLEAN NOT NULL DEFAULT false,
    "locale" TEXT,
    "collaborator" BOOLEAN DEFAULT false,
    "emailVerified" BOOLEAN DEFAULT false,
    "refreshToken" TEXT,
    "refreshTokenExpires" TIMESTAMP(3),

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UsageCounter" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "imagesUsed" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "UsageCounter_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShopSettings" (
    "shop" TEXT NOT NULL,
    "autoOptimize" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "ShopSettings_pkey" PRIMARY KEY ("shop")
);

-- CreateTable
CREATE TABLE "ImageSize" (
    "url" TEXT NOT NULL,
    "bytes" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ImageSize_pkey" PRIMARY KEY ("url")
);

-- CreateIndex
CREATE UNIQUE INDEX "UsageCounter_shop_period_key" ON "UsageCounter"("shop", "period");
