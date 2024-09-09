import { JettonMinter, JettonMinterConfig, jettonMinterConfigToCell } from './JettonMinter';
import { Address, beginCell, Cell, contractAddress, ContractProvider } from '@ton/core';

export class JettonMinterTest extends JettonMinter {
    constructor(readonly address: Address, readonly init?: { code: Cell; data: Cell }) {
        super(address, init);
    }
    static createFromAddress(address: Address) {
        return new JettonMinterTest(address);
    }

    static createFromConfig(config: JettonMinterConfig, code: Cell, workchain = 0) {
        const data = jettonMinterConfigToCell(config);
        const init = {code, data};
        return new JettonMinterTest(contractAddress(workchain, init), init);
    }

    async getSalt(provider: ContractProvider, owner: Address) {
        const { stack } = await provider.get('get_wallet_state_init_and_salt', [{
            type: 'slice',
            cell: beginCell().storeAddress(owner).endCell()
        }]);

        return {
            state_init: stack.readCell(),
            salt: stack.readBigNumber()
        }
    }
    async getSaltCheap(provider: ContractProvider, owner: Address) {
        const { stack } = await provider.get('get_wallet_state_init_and_salt_cheap', [{
            type: 'slice',
            cell: beginCell().storeAddress(owner).endCell()
        }]);

        return {
            state_init: stack.readCell(),
            salt: stack.readBigNumber()
        }
    }
}
