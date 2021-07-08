/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { isEqual } from '../../common/utils';

suite('Utils', () => {
	test('isEqual', () => {
        assert.ok(isEqual(['a'], ['a']))
        assert.ok(!isEqual(['a'], ['b']));
        assert.ok(!isEqual(['a', 'b'], ['b', 'a']));
    });
});