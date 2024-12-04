import { Address, beginCell, BitBuilder, Cell, Dictionary, DictionaryValue, exoticMerkleProof, exoticPruned, toNano, internal } from '@ton/core';
import {compile, NetworkProvider} from '@ton/blueprint';
//import { MnemonicProvider } from '@ton/blueprint';
import {jettonWalletCodeFromLibrary, promptUrl, promptUserFriendlyAddress} from "../wrappers/ui-utils";

import { WalletContractV3R2, WalletContractV4, WalletContractV5R1 } from "@ton/ton";
import { mnemonicNew, mnemonicToPrivateKey } from "@ton/crypto";


import '@ton/test-utils';
import {jettonContentToCell, JettonMinter} from '../wrappers/JettonMinter';
import { JettonWallet, jettonWalletConfigToCell } from '../wrappers/JettonWallet';
import { buff2bigint} from '../sandbox_tests/utils';
import { Errors, Op } from '../wrappers/JettonConstants';
const fs = require('fs');
const N = 20; // number of wallets of each kind to generate
const P = 6;  // number of packages of wallets to generate

const AIRDROP_START = 1722366929;
const AIRDROP_END   = 1724183052;


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

function convertToPrunedBranch(c: Cell): Cell {
    return beginCell()
        .storeUint(1, 8)
        .storeUint(1, 8)
        .storeBuffer(c.hash(0))
        .storeUint(c.depth(0), 16)
        .endCell({ exotic: true });
}

// for P packages it generates 3 * N wallets of each kind
// for each wallet it generates airdrop data with random amount from toNano("1") to toNano("23"), start_from = AIRDROP_START
// and expire_at linearly increased from AIRDROP_START to AIRDROP_END in each package and each wallet type


export async function generateWalletsWithAirdropData() {
    const allWallets = [];
    let workchain = 0;
    let totalSupply = 0n;
    let airdropData = Dictionary.empty(Dictionary.Keys.Address(), airDropValue);
    for (let pack = 0; pack < P; pack++) {
        let wallets = [];
        for (let i = 0; i < N; i++) {
            const mnemonic = await mnemonicNew();
            const keyPair = await mnemonicToPrivateKey(mnemonic);
            let wallet = WalletContractV3R2.create({ workchain, publicKey: keyPair.publicKey });
            //generate airdrop data
            let amount = toNano((Math.ceil(Math.random()*22) + 1).toString());
            totalSupply += amount;
            let start_from = AIRDROP_START;
            let expire_at = Math.ceil(AIRDROP_START + (AIRDROP_END - AIRDROP_START) * (i + 1) / N);
            airdropData.set(wallet.address, {amount, start_from, expire_at });
            wallets.push([mnemonic, "v3r2", wallet.address.toString()]);
        }
        for (let i = 0; i < N; i++) {
            const mnemonic = await mnemonicNew();
            const keyPair = await mnemonicToPrivateKey(mnemonic);
            let wallet = WalletContractV4.create({ workchain, publicKey: keyPair.publicKey });
            //generate airdrop data
            let amount = toNano((Math.ceil(Math.random()*22) + 1).toString());
            totalSupply += amount;
            let start_from = AIRDROP_START;
            let expire_at = Math.ceil(AIRDROP_START + (AIRDROP_END - AIRDROP_START) * (i + 1) / N);
            airdropData.set(wallet.address, {amount, start_from, expire_at });
            wallets.push([mnemonic, "v4", wallet.address.toString()]);
        }
        for (let i = 0; i < N; i++) {
            const mnemonic = await mnemonicNew();
            const keyPair = await mnemonicToPrivateKey(mnemonic);
            let wallet = WalletContractV5R1.create({ publicKey: keyPair.publicKey, walletId: { networkGlobalId: -3 } });
            //generate airdrop data
            let amount = toNano((Math.ceil(Math.random()*22) + 1).toString());
            totalSupply += amount;
            let start_from = AIRDROP_START;
            let expire_at = Math.ceil(AIRDROP_START + (AIRDROP_END - AIRDROP_START) * (i + 1) / N);
            airdropData.set(wallet.address, {amount, start_from, expire_at });
            wallets.push([mnemonic, "v5r1", wallet.address.toString()]);
        }
        allWallets.push(wallets);
    }
    let airdropCell   = beginCell().storeDictDirect(airdropData).endCell();
    let merkleRoot    = buff2bigint(airdropCell.hash(0));
    //receiverProof = airdropData.generateMerkleProof(testReceiver.address);
    // Now we want to iterate over all wallets and generate proof for each of them
    // finally for each pack we want to store into csv file the following data
    // mnemonic, wallet type, wallet address, airdrop amount, airdrop start_from, airdrop expire_at, receiver proof


    for (let pack = 0; pack < P; pack++) {
        let wallets = allWallets[pack];
        let csvData = [];
        for (let i = 0; i < wallets.length; i++) {
            let mnemonic = wallets[i][0];
            let type = wallets[i][1];
            let address = wallets[i][2];
            let airdrop = airdropData.get(Address.parse(address as string));
            let amount = airdrop!.amount;
            let start_from = airdrop!.start_from;
            let expire_at = airdrop!.expire_at;
            let receiverProof = airdropData.generateMerkleProof(Address.parse(address as string));
            //serialize receiverProof: toBoc, then Buffer to base64
            let serializedProof = receiverProof.toBoc().toString('base64');
            csvData.push([mnemonic, type, address, amount, start_from, expire_at, serializedProof]);
        }
        // write csvData to csv file
        // dont use csv libraries
        // write csv header
        let csv = "mnemonic, type, address, amount, start_from, expire_at, receiver_proof\n";
        for (let i = 0; i < csvData.length; i++) {
            csv += csvData[i].join(",") + "\n";
        }
        fs.writeFileSync(`wallets${pack}.csv`, csv);
    }

    // store serialized airdropCell to file as buffer
    let serializedAirdropCell = airdropCell.toBoc();
    fs.writeFileSync("airdropData.boc", serializedAirdropCell);


    return {merkleRoot, allWallets, airdropData, totalSupply};
}



export async function run(provider: NetworkProvider) {
    const isTestnet = provider.network() !== 'mainnet';
    let data = await generateWalletsWithAirdropData();

    const ui = provider.ui();
    const adminAddress = await promptUserFriendlyAddress("Enter the address of the jetton owner (admin):", ui, isTestnet);

    const jettonMetadataUri = await promptUrl("Enter jetton metadata uri (https://jettonowner.com/jetton.json)", ui)


    let merkleRoot = data.merkleRoot;
    let allWallets = data.allWallets;

    let wallet_code_raw = await compile('JettonWallet');
    const wallet_code = jettonWalletCodeFromLibrary(wallet_code_raw);
    let minter_code = await compile('JettonMinter');
    let minterContract = JettonMinter.createFromFullConfig({admin: adminAddress.address,
                                                        wallet_code:wallet_code,
                                                        merkle_root: merkleRoot,
                                                        jetton_content: jettonContentToCell({uri: jettonMetadataUri}),
                                                        supply: data.totalSupply,
                                                        transfer_admin: null,
                                                        }, minter_code);
    let minter = provider.open(minterContract);
    await minter.sendDeploy(provider.sender(), toNano("1.5"));
    console.log("Minter deployed at address: ", minter.address.toString());
    // save minter address to file minter.json
    fs.writeFileSync("minter.json", JSON.stringify({address: minter.address.toString()}));

    // now lets send 1 TON to first wallet of first package
    let mnemonic = allWallets[0][0][0] as string[];
    let keyPair = await mnemonicToPrivateKey(mnemonic);
    let walletContract = WalletContractV3R2.create({ workchain: 0, publicKey: keyPair.publicKey });
    let wallet = provider.open(walletContract);
    // wait 40 seconds
    console.log("Wallet address: ", wallet.address.toString());
    await new Promise(resolve => setTimeout(resolve, 40000));
    await provider.sender().send({
                                                 to: wallet.address,
                                                 value: toNano('1')
                                             });
    let walletSender = wallet.sender(keyPair.secretKey);
    console.log("Wallet address: ", wallet.address.toString());

    //now lets create jetton wallet owned by wallet
    // get salt from minter for correct init state
    const jettonWalletSalt = await minter.getWalletSalt(wallet.address);

    let jettonWalletContract = JettonWallet.createFromConfig({ownerAddress: wallet.address,
                                                      jettonMasterAddress: minter.address,
                                                      merkleRoot: merkleRoot,
                                                      salt: jettonWalletSalt,
    }, wallet_code);
    let jettonWallet = provider.open(jettonWalletContract);

    //deserialize proof
    let receiverProof = data.airdropData.generateMerkleProof(wallet.address);
    const claimPayload = JettonWallet.claimPayload(receiverProof);

    await jettonWallet.sendTransfer(walletSender, toNano('0.3'),
                                    toNano('0.1'), wallet.address,
                                    wallet.address, claimPayload, 1n);

}
