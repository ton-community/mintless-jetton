import { Address, beginCell, BitBuilder, Cell, Dictionary, DictionaryValue, exoticMerkleProof, exoticPruned, fromNano, toNano } from '@ton/core';
import { compile } from '@ton/blueprint';
import { Blockchain, BlockchainSnapshot, EmulationError, SandboxContract, TreasuryContract, internal } from '@ton/sandbox';
import '@ton/test-utils';
import {jettonContentToCell, JettonMinter} from '../wrappers/JettonMinter';
import { JettonWallet, jettonWalletConfigToCell } from '../wrappers/JettonWallet';
import { buff2bigint, getRandomInt, getRandomTon, randomAddress, testJettonInternalTransfer } from './utils';
import { Errors, Op } from '../wrappers/JettonConstants';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { computedGeneric, computeGasFee, getGasPrices } from '../gasUtils';

type AirdropData = {
    amount: bigint,
    start_from: number,
    expire_at: number
};

const airDropValue: DictionaryValue<AirdropData> = {
    serialize: (src, builder) => {
        builder.storeCoins(src.amount);
        builder.storeUint(src.start_from, 48);
        builder.storeUint(src.expire_at, 48);
    },
    parse: (src) => {
        return {
            amount: src.loadCoins(),
            start_from: src.loadUint(48),
            expire_at: src.loadUint(48)
        }
    }
}

function convertToMerkleProof(c: Cell): Cell {
    return beginCell()
        .storeUint(3, 8)
        .storeBuffer(c.hash(0))
        .storeUint(c.depth(0), 16)
        .storeRef(c)
        .endCell({ exotic: true });
}

function convertToMerkleUpdate(c1: Cell, c2: Cell): Cell {
    return beginCell()
        .storeUint(4, 8)
        .storeBuffer(c1.hash(0))
        .storeBuffer(c2.hash(0))
        .storeUint(c1.depth(0), 16)
        .storeUint(c2.depth(0), 16)
        .storeRef(c1)
        .storeRef(c2)
        .endCell({ exotic: true });
}

function convertToPrunedBranch(c: Cell): Cell {
    return beginCell()
        .storeUint(1, 8)
        .storeUint(1, 8)
        .storeBuffer(c.hash(0))
        .storeUint(c.depth(0), 16)
        .endCell({ exotic: true });
}

describe('Claim tests', () => {
    const AIRDROP_START = 1000;
    const AIRDROP_END   = 2000;

    let wallet_code: Cell;
    let minter_code: Cell;

    let blockchain: Blockchain;
    let initialState: BlockchainSnapshot;
    let claimedAlready: BlockchainSnapshot;
    let merkleRoot: bigint;
    let defaultContent: Cell;
    let cMaster: SandboxContract<JettonMinter>;
    let airdropData: Dictionary<Address, AirdropData>;
    let airdropCell: Cell;
    let deployer: SandboxContract<TreasuryContract>;
    let testReceiver: SandboxContract<TreasuryContract>;

    let receiverProof: Cell;

    let userWallet: (address: Address, root?: bigint) => Promise<SandboxContract<JettonWallet>>;
    let getContractData:(address: Address) => Promise<Cell>;
    // Minimal transfer cost no claim
    const minimalTransfer = toNano('0.073225413');
    // Transfer compute phase gas
    const transferNoClaim = 30766n;

    beforeAll(async () => {
        wallet_code = await compile('JettonWallet');
        minter_code = await compile('JettonMinter');

        blockchain = await Blockchain.create();
        blockchain.now = 1;
        deployer     = await blockchain.treasury('deployer');
        testReceiver = await blockchain.treasury('receiver');
        airdropData = Dictionary.empty(Dictionary.Keys.Address(), airDropValue);

        // const others = await blockchain.createWallets(10);

        airdropData.set(testReceiver.address, {
            amount: toNano('100'),
            expire_at: AIRDROP_END,
            start_from: AIRDROP_START
        });

        /*
        for(let otherWallet of others) {
            airdropData.set(otherWallet.address, {
                amount: toNano('100'),
                expire_at: AIRDROP_END,
                start_from: AIRDROP_START
            });
        }
        */

        airdropCell   = beginCell().storeDictDirect(airdropData).endCell();
        merkleRoot    = buff2bigint(airdropCell.hash(0));
        receiverProof = airdropData.generateMerkleProof(testReceiver.address);


        defaultContent = jettonContentToCell({
                uri: 'https://some_jetton.com/meta.json'
        })
        cMaster = blockchain.openContract(JettonMinter.createFromConfig({
            admin: deployer.address,
            wallet_code,
            merkle_root: merkleRoot,
            jetton_content: defaultContent
        }, minter_code));

        const masterDeploy = await cMaster.sendDeploy(deployer.getSender(), toNano('1000'));
        expect(masterDeploy.transactions).toHaveTransaction({
            on: cMaster.address,
            from: deployer.address,
            aborted: false,
            deploy: true
        });

        blockchain.now = AIRDROP_START;

        initialState = blockchain.snapshot();

        userWallet = async (address:Address, root?: bigint) => {
           let userMinter: SandboxContract<JettonMinter>;
           if(root) {
               userMinter = blockchain.openContract(
                   JettonMinter.createFromConfig({
                       admin: deployer.address,
                       jetton_content: defaultContent,
                       wallet_code,
                       merkle_root: root
                   }, minter_code)
               );
               const smc = await blockchain.getContract(userMinter.address);
               if(smc.accountState == undefined || smc.accountState.type !== 'active') {
                   await userMinter.sendDeploy(deployer.getSender(), toNano('100'));
               }
           }
           else {
               userMinter = cMaster;
           }
           const newWallet = JettonWallet.createFromConfig({
               ownerAddress: address,
               jettonMasterAddress: userMinter.address,
               merkleRoot: root ?? merkleRoot,
               salt: await userMinter.getWalletSalt(address)
           }, wallet_code);
           return blockchain.openContract(newWallet);
       }
       getContractData = async (address: Address) => {
         const smc = await blockchain.getContract(address);
         if(!smc.account.account)
           throw new Error("Account not found")
         if(smc.account.account.storage.state.type != "active" )
           throw new Error("Atempting to get data on inactive account");
         if(!smc.account.account.storage.state.state.data)
           throw new Error("Data is not present");
         return smc.account.account.storage.state.state.data
       }
    });
    beforeEach(async () => {
        // Roll back the blockchain and airdrop state
        await blockchain.loadFrom(initialState)
        airdropData = airdropCell.beginParse().loadDictDirect(Dictionary.Keys.Address(), airDropValue);
    });

    it('should claim and transfer', async () => {
        const testJetton   = await userWallet(testReceiver.address);
        const claimPayload = JettonWallet.claimPayload(receiverProof);
        const userData     = airdropData.get(testReceiver.address)!;
        const transferAmount = getRandomTon(1, 99);
        const res = await testJetton.sendTransfer(testReceiver.getSender(), toNano('1'),
                                                  transferAmount, deployer.address,
                                                  testReceiver.address, claimPayload, 1n);

        expect(res.transactions).toHaveTransaction({
            on: testJetton.address,
            aborted: false,
            deploy: true
        });
        const deployerJetton = await userWallet(deployer.address);
        expect(res.transactions).toHaveTransaction({
            on: deployerJetton.address,
            from: testJetton.address,
            op: Op.internal_transfer,
            body: (b) => testJettonInternalTransfer(b!, {
                amount: transferAmount,
                from: testReceiver.address
            })
        });
            

        expect(await deployerJetton.getJettonBalance()).toEqual(transferAmount);
        expect(await testJetton.getJettonBalance()).toEqual(userData.amount - transferAmount);
        
        claimedAlready = blockchain.snapshot();
    });
    it('should not allow to claim twice', async () => {
        await blockchain.loadFrom(claimedAlready);

        const claimPayload = JettonWallet.claimPayload(receiverProof);
        const testJetton = await userWallet(testReceiver.address);
        const totalBalance = await testJetton.getJettonBalance();

        const dataBefore = await getContractData(testJetton.address);

        const res = await testJetton.sendTransfer(testReceiver.getSender(), toNano('1'),
                                                  totalBalance, deployer.address,
                                                  deployer.address, claimPayload, 1n);

        expect(res.transactions).toHaveTransaction({
            on: testJetton.address,
            from: testReceiver.address,
            op:Op.transfer,
            success: false,
            aborted: true,
            exitCode: Errors.airdrop_already_claimed
        });

        expect(await getContractData(testJetton.address)).toEqualCell(dataBefore);
    });
    it('should accept only known custom payload', async () => {
        const testJetton = await userWallet(testReceiver.address);
        let randomOp: number;

        do {

            randomOp = getRandomInt(0, (1 << 32) - 1);

        } while(randomOp == Op.airdrop_claim);

        const ops = [Op.transfer, Op.burn, randomOp]

        for(let testOp of ops) {
            const claimPayload = beginCell().storeUint(testOp, 32).storeRef(receiverProof).endCell();
            const res = await testJetton.sendTransfer(testReceiver.getSender(), toNano('1'),
                                                      1n, deployer.address,
                                                      deployer.address, claimPayload, 1n);
            expect(res.transactions).toHaveTransaction({
                on: testJetton.address,
                from: testReceiver.address,
                aborted: true,
                success: false,
                exitCode: Errors.unknown_custom_payload
            });
        }
    });
    it('should not allow to claim before airdrop start', async () => {
        blockchain.now = AIRDROP_START - 1;
        const claimPayload = JettonWallet.claimPayload(receiverProof);
        const testJetton = await userWallet(testReceiver.address);

        const res = await testJetton.sendTransfer(testReceiver.getSender(), toNano('1'),
                                                  1n, deployer.address,
                                                  deployer.address, claimPayload, 1n);

        expect(res.transactions).toHaveTransaction({
            on: testJetton.address,
            from: testReceiver.address,
            op:Op.transfer,
            aborted: true,
            success: false,
            exitCode: Errors.airdrop_not_ready
        });
    });
    it('should not allow to claim airdrop after it has ended', async () => {
        blockchain.now = AIRDROP_END + 1;

        const claimPayload = JettonWallet.claimPayload(receiverProof);
        const testJetton = await userWallet(testReceiver.address);

        const res = await testJetton.sendTransfer(testReceiver.getSender(), toNano('1'),
                                                  1n, deployer.address,
                                                  deployer.address, claimPayload, 1n);

        expect(res.transactions).toHaveTransaction({
            on: testJetton.address,
            from: testReceiver.address,
            op:Op.transfer,
            aborted: true,
            success: false,
            exitCode: Errors.airdrop_finished
        });
    });
    it('claim fee should be accounted for in transfer', async () => {
        const claimPayload = JettonWallet.claimPayload(receiverProof);
        const testJetton = await userWallet(testReceiver.address);

        // Should fail, because claim cost is not accounted in minimal fee

        let res = await testJetton.sendTransfer(testReceiver.getSender(), minimalTransfer,
                                                1n, deployer.address,
                                                deployer.address, claimPayload, 1n);

        expect(res.transactions).toHaveTransaction({
            on: testJetton.address,
            from: testReceiver.address,
            op:Op.transfer,
            aborted: true,
            success: false,
            exitCode: Errors.not_enough_gas
        });

        res = await testJetton.sendTransfer(testReceiver.getSender(), toNano('0.13'),
                                            1n, deployer.address,
                                            deployer.address, claimPayload, 1n);

        expect(res.transactions).toHaveTransaction({
            on: testJetton.address,
            from: testReceiver.address,
            op:Op.transfer,
            success: true,
        });
    });
    it('claim fee should be dynamic based on dictionary lookup cost', async () => {
        // Let's try much larger dictionary

        /*
        for(let i = 0; i < 1000; i++) {
            airdropData.set(randomAddress(), {
                amount: toNano('100'),
                start_from: AIRDROP_START,
                expire_at: AIRDROP_END
            });
        }

        const testTree = beginCell().storeDictDirect(airdropData).endCell();
        */

        const proofString = await readFile(join('sandbox_tests','proof'), {encoding: 'utf8'});
        const parts = proofString.split(',');
        const testAddress = Address.parse(parts[0]);
        const newProof = Cell.fromBase64(parts[1]);
        console.log("New proof depth:", newProof.depth(0));
        const newRoot  = buff2bigint(newProof.refs[0].hash(0));
        console.log("New root:", newRoot.toString(16));
        const claimPayload = JettonWallet.claimPayload(newProof);

        const testJetton = await userWallet(testAddress, newRoot);
        const deployerJetton = await userWallet(deployer.address, newRoot);
        const balanceBefore  = await deployerJetton.getJettonBalance();
        const testSender = blockchain.sender(testAddress);

        const transferMessage = JettonWallet.transferMessage(1n, deployer.address,
                                                             deployer.address,
                                                             claimPayload, 1n);
        let res = await blockchain.sendMessage(internal({
            to: testJetton.address,
            from: testAddress,
            body: transferMessage,
            value: toNano('0.05'),
            stateInit: testJetton.init
        }));
        /*
        let res = await testJetton.sendTransfer(testSender, toNano('0.13'), // Success value from previous case
                                                1n, deployer.address,
                                                deployer.address, claimPayload, 1n);
        */

        expect(res.transactions).toHaveTransaction({
            on: testJetton.address,
            from: testAddress,
            op:Op.transfer,
            aborted: true,
            success: false,
            exitCode: Errors.not_enough_gas
        });

        /*
        res = await testJetton.sendTransfer(testSender, toNano('1'),
                                            1n, deployer.address,
                                            deployer.address, claimPayload, 1n);
        */

        res = await blockchain.sendMessage(internal({
            to: testJetton.address,
            from: testAddress,
            body: transferMessage,
            value: toNano('1'),
            stateInit: testJetton.init
        }));

        expect(res.transactions).toHaveTransaction({
            on: testJetton.address,
            from: testAddress,
            op:Op.transfer,
            success: true,
        });
        expect(await deployerJetton.getJettonBalance()).toEqual(balanceBefore + 1n);
        const claimTransferCompute = computedGeneric(res.transactions[1]);
        const gasPrices = getGasPrices(blockchain.config, 0);
        const gasDelta  = claimTransferCompute.gasUsed - transferNoClaim;
        console.log(`Transfer additional gas:${gasDelta}`);
        console.log(`Just transfer:${minimalTransfer}`);
        console.log(`Total claim + transfer cost ${fromNano(minimalTransfer + computeGasFee(gasPrices, gasDelta))}`);
    });
    describe('Proofs', () => {
    it('should reject proof from different root', async () => {
        const evilDude     = await blockchain.treasury('3v1l');
        const evilJetton   = await userWallet(evilDude.address);

        airdropData.set(evilDude.address, {
            amount: toNano('1000000'),
            expire_at: 1100,
            start_from: 1000
        });

        const evilProof = airdropData.generateMerkleProof(evilDude.address);
        const claimPayload = JettonWallet.claimPayload(evilProof);

        const res = await evilJetton.sendTransfer(evilDude.getSender(), toNano('1'),
                                                  1n, testReceiver.address,
                                                  evilDude.address, claimPayload, 1n);
        expect(res.transactions).toHaveTransaction({
            on: evilJetton.address,
            from: evilDude.address,
            op: Op.transfer,
            aborted: true,
            exitCode: Errors.wrong_hash
        });
    });
    // This one is skipped by default, because it requires @ton/core modifications to ingore hash check at cell creation level
    it.skip('should reject fake proof', async () => {
        const evilDude     = await blockchain.treasury('3v1l');
        const evilJetton   = await userWallet(evilDude.address);

        airdropData.set(evilDude.address, {
            amount: toNano('1000000'),
            expire_at: 1100,
            start_from: 1000
        });

        const evilProof  = airdropData.generateMerkleProof(evilDude.address);
        // Pruned dictionary with evil data added
        const prunedPath = evilProof.refs[0];

        const fakeProof = beginCell().storeUint(3, 8)
                                     .storeBuffer(airdropCell.hash(0))
                                     .storeUint(prunedPath.depth(0), 16)
                                     .storeRef(prunedPath)
                          .endCell({exotic: true});

        const claimPayload = JettonWallet.claimPayload(fakeProof);

        // We're checking that boc parsing would not allow to send non-valid proof
        // So it can never reach the contract
        expect(evilJetton.sendTransfer(evilDude.getSender(), toNano('1'),
                                       1n, testReceiver.address,
                                       evilDude.address, claimPayload, 1n)).rejects.toThrowError(/Hash mismatch/);
    });
    it('should reject ordinary cell', async () => {
        const evilDude     = await blockchain.treasury('3v1l');
        const evilJetton   = await userWallet(evilDude.address);

        airdropData.set(evilDude.address, {
            amount: toNano('1000000'),
            expire_at: 1100,
            start_from: 1000
        });

        const evilProof  = airdropData.generateMerkleProof(evilDude.address);
        // Pruned dictionary with evil data added
        const prunedPath = evilProof.refs[0];

        /* So the idea is that one could atempt to create
         Normal cell with same data structure
         Therefore this cell boc won't be checked against merkle proof standards
         and could theoreticlly reach the contract
        */
        const fakeProof = beginCell().storeBuffer(airdropCell.hash(0))
                                     .storeUint(prunedPath.depth(0), 16)
                          .endCell();

        const claimPayload = JettonWallet.claimPayload(fakeProof);

        const res = await evilJetton.sendTransfer(evilDude.getSender(), toNano('1'),
                                                  1n, testReceiver.address,
                                                  evilDude.address, claimPayload, 1n);
        expect(res.transactions).toHaveTransaction({
            on: evilJetton.address,
            from: evilDude.address,
            op: Op.transfer,
            success: false,
            aborted: true,
            exitCode: Errors.not_exotic
        });
    });
    it('should reject library', async () => {
        const evilDude     = await blockchain.treasury('3v1l');
        const evilJetton   = await userWallet(evilDude.address);

        airdropData.set(evilDude.address, {
            amount: toNano('1000000'),
            expire_at: 1100,
            start_from: 1000
        });

        const evilProof  = airdropData.generateMerkleProof(evilDude.address);
        // Pruned dictionary with evil data added
        const prunedPath = evilProof.refs[0];

        const fakeProof = beginCell().storeUint(2, 8)
                                     .storeBuffer(airdropCell.hash(0))
                                     .storeRef(prunedPath)
                          .endCell({exotic: true});

        const claimPayload = JettonWallet.claimPayload(fakeProof);

        const res = await evilJetton.sendTransfer(evilDude.getSender(), toNano('1'),
                                                  1n, testReceiver.address,
                                                  evilDude.address, claimPayload, 1n);
        expect(res.transactions).toHaveTransaction({
            on: evilJetton.address,
            from: evilDude.address,
            op: Op.transfer,
            success: false,
            aborted: true,
            exitCode: Errors.not_merkle_proof
        });
    });
    it('should reject merkle update', async () => {
        const evilDude     = await blockchain.treasury('3v1l');
        const evilJetton   = await userWallet(evilDude.address);

        // In this case we would just test different types on a valid cell
        // and make sure type error is triggered

        const merkleUpd = convertToMerkleUpdate(airdropCell, airdropCell);

        const claimPayload = JettonWallet.claimPayload(merkleUpd);
        const res = await evilJetton.sendTransfer(evilDude.getSender(), toNano('1'),
                                                  1n, testReceiver.address,
                                                  evilDude.address, claimPayload, 1n);
        expect(res.transactions).toHaveTransaction({
            on: evilJetton.address,
            from: evilDude.address,
            op: Op.transfer,
            success: false,
            aborted: true,
            exitCode: Errors.not_merkle_proof
        });
    });
    it('should reject pruned branch', async () => {
        /* We can't really test that on a contract level,
        * because pruned branch could only be a child of
        * MerkleProof/MerkleUpdate and not an ordinary cell
        * So, all we can do is just test that statement above is true
        */

        const evilDude     = await blockchain.treasury('3v1l');
        const evilJetton   = await userWallet(evilDude.address);

        const prunedUpd = convertToPrunedBranch(airdropCell);
        const claimPayload = JettonWallet.claimPayload(prunedUpd);

        expect(evilJetton.sendTransfer(evilDude.getSender(), toNano('1'),
                                                  1n, testReceiver.address,
                                                  evilDude.address, claimPayload, 1n)).rejects.toThrow(EmulationError);
    });

    it('should reject proof for non-present address', async () => {
        const evilDude     = await blockchain.treasury('3v1l');
        const evilJetton   = await userWallet(evilDude.address);
        const claimPayload = JettonWallet.claimPayload(receiverProof);

        // So someone atempted to replay proof as is

        let res = await evilJetton.sendTransfer(evilDude.getSender(), toNano('1'),
                                                1n, testReceiver.address,
                                                evilDude.address, claimPayload, 1n);
        expect(res.transactions).toHaveTransaction({
            on: evilJetton.address,
            from: evilDude.address,
            op: Op.transfer,
            success: false,
            aborted: true,
            // 9 will happen if pruned branch path is being used while trying to look up the value
            exitCode: (c) => c == 9 || c == Errors.airdrop_not_found
        });
        // Full tree no pruned branches, to guarantee 9 won't happen
        const fullDict = convertToMerkleProof(airdropCell);

        res = await evilJetton.sendTransfer(evilDude.getSender(), toNano('1'),
                                            1n, testReceiver.address,
                                            evilDude.address, claimPayload, 1n);

        expect(res.transactions).toHaveTransaction({
            on: evilJetton.address,
            from: evilDude.address,
            op: Op.transfer,
            success: false,
            aborted: true,
            exitCode: Errors.airdrop_not_found
        });


    });
    });
});
