-- 0010_billing_refund_id.sql — Add razorpay_refund_id column to billing table
ALTER TABLE billing ADD COLUMN razorpay_refund_id TEXT;
