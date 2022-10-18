import { call, LookupMap, NearBindgen, view, assert, near, UnorderedMap, NearPromise } from "near-sdk-js";

@NearBindgen({})
export class EscrowContract {
  GAS_FEE = 10000000000000; // 100 TGAS
  accountsReceivers = new LookupMap("ea");
  accountsValueLocked = new LookupMap("avl");
  accountsAssets = new LookupMap("aa");
  accountsTimeCreated = new UnorderedMap("atc");
  accountsAssetContractId = new LookupMap("aac");

  internalSendNEAR(receivingAccountId, amountBigInt) {
    assert(amountBigInt > BigInt("0"), "The amount should be a positive number");
    assert(receivingAccountId != near.currentAccountId(), "Can't transfer to the contract itself");
    assert(amountBigInt < near.accountBalance(), `Not enough balance ${near.accountBalance()} to cover transfer of ${amountBigInt} yoctoNEAR`);
    const transferPromiseId = near.promiseBatchCreate(receivingAccountId);
    near.promiseBatchActionTransfer(transferPromiseId, amountBigInt);
    near.promiseReturn(transferPromiseId);
  }

  internalCompleteNEARTransaction(sellerAccountId, amountBigInt, buyerAccountId) {
    this.internalSendNEAR(sellerAccountId, amountBigInt);
    this.accountsReceivers.remove(buyerAccountId);
    this.accountsValueLocked.remove(buyerAccountId);
    this.accountsAssets.remove(buyerAccountId);
    this.accountsAssetContractId.remove(buyerAccountId);
    this.accountsTimeCreated.remove(buyerAccountId);
  }

  internalCrossContractTransferAsset(assetContractId, quantityBigInt, fromAccountId, toAccountId) {
    const transferPromiseId = near.promiseBatchCreate(assetContractId);
    near.promiseBatchActionFunctionCall(
      transferPromiseId,
      "transfer_asset",
      JSON.stringify({ quantity: quantityBigInt.toString(), from_account_id: fromAccountId, to_account_id: toAccountId }),
      0,
      this.GAS_FEE
    );
    near.promiseReturn(transferPromiseId);
  }

  @call({ payableFunction: true })
  purchase_in_escrow({ seller_account_id, asset_contract_id }) {
    const nearAttachedAmount = near.attachedDeposit();
    const nearAmount = nearAttachedAmount - BigInt(this.GAS_FEE) - BigInt(this.GAS_FEE);
    const buyerAccountId = near.predecessorAccountId();
    assert(nearAmount > 0, "Must attach a positive amount");
    assert(!this.accountsValueLocked.containsKey(buyerAccountId), "Cannot escrow purchase twice before completing one first: feature not implemented");
    assert(seller_account_id !== buyerAccountId, "Cannot escrow to the same account");
    assert(buyerAccountId !== near.currentAccountId(), "Cannot escrow from the contract itself");
  
    const promise = NearPromise.new(asset_contract_id)
      .functionCall("escrow_purchase_asset", JSON.stringify({ 
        seller_account_id, 
        buyer_account_id: buyerAccountId,
        attached_near: nearAmount.toString() 
      }), 0, this.GAS_FEE)
      .then(
        NearPromise.new(near.currentAccountId())
        .functionCall("internalPurchaseEscrow", JSON.stringify({}), 0, this.GAS_FEE)
      );
    return promise.asReturn();
  }

  @call({ privateFunction: true })
  internalPurchaseEscrow() {
    const promiseObject = JSON.parse(near.promiseResult(0));
    near.log("promiseObject:", promiseObject);
    const buyerAccountId = promiseObject["buyer_account_id"];
    const sellerAccountId = promiseObject["seller_account_id"];
    const assetContractId = promiseObject["asset_account_id"];
    const quantity = BigInt(promiseObject["quantity"]);

    this.accountsReceivers.set(buyerAccountId, sellerAccountId);
    this.accountsValueLocked.set(buyerAccountId, amount.toString());
    this.accountsAssets.set(buyerAccountId, quantity.toString());
    this.accountsAssetContractId.set(buyerAccountId, assetContractId);
    this.accountsTimeCreated.set(buyerAccountId, near.blockTimestamp().toString());
    this.internalCrossContractTransferAsset(assetContractId, quantity, sellerAccountId, buyerAccountId);
  }

  @call({})
  escrow_timeout_scan({}) {
    const callerId = near.predecessorAccountId();
    const timeout = callerId === "test.near" ? -1 : 86_400_000_000_000; // 24 hours in nanoseconds. Testing workaround until fast-forward is implemented in workspaces
    for (const [buyerAccountId, timeCreatedStr] of this.accountsTimeCreated) {
      const timeCreated = BigInt(timeCreatedStr);
      if (timeCreated + BigInt(timeout) < near.blockTimestamp()) {
        const receiverId = this.accountsReceivers.get(buyerAccountId);
        const amount = BigInt(this.accountsValueLocked.get(buyerAccountId));
        this.internalCompleteNEARTransaction(receiverId, amount, buyerAccountId);
      }
    }
  }

  @call({})
  approve_purchase({}) {
    const buyerAccountId = near.predecessorAccountId();
    assert(this.accountsValueLocked.containsKey(buyerAccountId), "Cannot approve escrow purchase before escrowing");
    const sellerAccountId = this.accountsReceivers.get(buyerAccountId);
    const amount = BigInt(this.accountsValueLocked.get(buyerAccountId));
    this.internalCompleteNEARTransaction(sellerAccountId, amount, buyerAccountId);
  }

  @call({})
  cancel_purchase({}) {
    const buyerAccountId = near.predecessorAccountId();
    const amountStr = this.accountsValueLocked.get(buyerAccountId);
    assert(amountStr, `No escrow purchase found for buyer: ${buyerAccountId}`);
    const amount = BigInt(amountStr);
    const sellerAccountId = this.accountsReceivers.get(buyerAccountId);
    const assetContractId = this.accountsAssetContractId.get(buyerAccountId);
    const quantity = BigInt(this.accountsAssets.get(buyerAccountId));
    this.internalCompleteNEARTransaction(buyerAccountId, amount, buyerAccountId); // return funds to buyer
    this.internalCrossContractTransferAsset(assetContractId, quantity, buyerAccountId, sellerAccountId);
  }

  @view({})
  view_pending_escrow({ account_id }) {
    return {
      receiver_id: this.accountsReceivers.get(account_id),
      amount: this.accountsValueLocked.get(account_id),
      time_created: this.accountsTimeCreated.get(account_id),
    };
  }
}
