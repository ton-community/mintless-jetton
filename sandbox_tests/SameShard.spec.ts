import { Blockchain, SandboxContract, TreasuryContract, internal, BlockchainSnapshot, SendMessageResult, BlockchainTransaction } from '@ton/sandbox';
import { Cell, toNano, beginCell, Address, Dictionary, fromNano } from '@ton/core';
import '@ton/test-utils';
import { compile } from '@ton/blueprint';
import { JettonMinterTest } from '../wrappers/JettonMinterTest';
import { JettonWallet } from '../wrappers/JettonWallet';
import { jettonContentToCell } from '../wrappers/JettonMinter';
import { getSecureRandomBytes } from '@ton/crypto';
import { getRandomInt } from './utils';


describe('SameShard', () => {
    let blockchain: Blockchain;
    let minter_code = new Cell();
    let userWallet: (address: Address) => Promise<SandboxContract<JettonWallet>>;
    let merkleRoot: bigint;
    let deployer: SandboxContract<TreasuryContract>;
    let jettonMinter: SandboxContract<JettonMinterTest>;

    beforeAll(async () => {
        blockchain  = await Blockchain.create();
        minter_code = await compile('JettonMinterTest');
        const wallet_code = await compile('JettonWallet');
        deployer = await blockchain.treasury('deployer_wallet');

        const _libs = Dictionary.empty(Dictionary.Keys.BigUint(256), Dictionary.Values.Cell());
        _libs.set(BigInt(`0x${wallet_code.hash().toString('hex')}`), wallet_code);
        const libs = beginCell().storeDictDirect(_libs).endCell();
        blockchain.libs = libs;
        let lib_prep = beginCell().storeUint(2,8).storeBuffer(wallet_code.hash()).endCell();
        const jwallet_code = new Cell({ exotic:true, bits: lib_prep.bits, refs:lib_prep.refs});
        merkleRoot   = BigInt('0x' + (await getSecureRandomBytes(32)).toString('hex'));


        const defaultContent = {
                           uri: 'https://some_stablecoin.org/meta.json'
                       };

        jettonMinter   = blockchain.openContract(
                   JettonMinterTest.createFromConfig(
                     {
                       admin: deployer.address,
                       wallet_code: jwallet_code,
                       merkle_root: merkleRoot, // We don't care about the claim here
                       jetton_content: jettonContentToCell(defaultContent)
                     },
                     minter_code));

        const deployResult = await jettonMinter.sendDeploy(deployer.getSender(), toNano('10'));
        expect(deployResult.transactions).toHaveTransaction({
            from: deployer.address,
            to: jettonMinter.address,
            deploy: true,
            aborted: false
        });
        userWallet = async (address:Address) => blockchain.openContract(
                          JettonWallet.createFromAddress(
                            await jettonMinter.getWalletAddress(address)
                          ));
    });
    it('should mint wallet to closest to receiver shard', async () => {
        const mintAmount = toNano('1000');
        let successCount = 0;

        for(let i = 0; i < 100; i++) {
            try {
                const testAddress = new Address(0, await getSecureRandomBytes(32));
                const testJetton = await userWallet(testAddress);
                const mintResult = await jettonMinter.sendMint(deployer.getSender(), testAddress, mintAmount, null, null, null, toNano('0.05'), toNano('1'));
                expect(await testJetton.getJettonBalance()).toEqual(mintAmount);
                expect(testJetton.address.hash[0] >> 4).toEqual(testAddress.hash[0] >> 4);
                successCount++;
            } catch(e) {
            }
        }
        console.log(`Same shard mint ${successCount}/100`);
        expect(successCount).toBeGreaterThanOrEqual(80);
    });
    it('should create wallet in closest shard on transfer', async () => {
        const mintAmount = toNano('1000');
        const deployerJetton = await userWallet(deployer.address);
        const mintResult = await jettonMinter.sendMint(deployer.getSender(), deployer.address, mintAmount, null, null, null, toNano('0.05'), toNano('1'));
        let successCount = 0;

        for(let i = 0; i < 100; i++) {
            try {
                const testAddress = new Address(0, await getSecureRandomBytes(32));
                const testJetton  = await userWallet(testAddress);
                await deployerJetton.sendTransfer(deployer.getSender(),
                                                  toNano('1'),
                                                  1n,
                                                  testAddress,
                                                  deployer.address,
                                                  null,
                                                  1n,
                                                  null);
                expect(await testJetton.getJettonBalance()).toEqual(1n);
                expect(testJetton.address.hash[0] >> 4).toEqual(testAddress.hash[0] >> 4);
                successCount++;
            } catch(e) {
            }
        }
        console.log(`Same shard transfer ${successCount}/100`);
        expect(successCount).toBeGreaterThanOrEqual(80);
    });
    it('cheap and regular result should match (1000 calls)', async () => {
        for(let i = 0; i < 1000; i++) {
            const testAddress = new Address(0, await getSecureRandomBytes(32));
            const cheap       = await jettonMinter.getSaltCheap(testAddress);
            const regular     = await jettonMinter.getSalt(testAddress);
            expect(cheap.salt).toEqual(regular.salt);
            expect(cheap.state_init).toEqualCell(regular.state_init);
        }
    });
    it.skip('cheap and regular result should match in a long run (10K calls)', async () => {
        for(let i = 0; i < 10000; i++) {
            const testAddress = new Address(0, await getSecureRandomBytes(32));
            const cheap       = await jettonMinter.getSaltCheap(testAddress);
            const regular     = await jettonMinter.getSalt(testAddress);
            if(i % 1000 == 0) {
                console.log(i);
            }
            expect(cheap.salt).toEqual(regular.salt);
            expect(cheap.state_init).toEqualCell(regular.state_init);
        }
    });
});
