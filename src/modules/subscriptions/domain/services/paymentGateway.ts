export interface ChargeRequest {
  subscriptionId: string;
  userId: string;
  amountCents: number;
  /** Same key for the same billing period, so a retried run can't charge twice. */
  idempotencyKey: string;
}

export interface ChargeResult {
  succeeded: boolean;
}

export interface PaymentGateway {
  charge(request: ChargeRequest): Promise<ChargeResult>;
}
