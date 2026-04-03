// Tests for iOS version bumping in the release script.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

// The release script uses these regex replacements on project.pbxproj.
// We test them against realistic pbxproj content to catch regressions.

const SAMPLE_PBXPROJ = `
			504EC3171FED79650016851F /* Debug */ = {
				isa = XCBuildConfiguration;
				buildSettings = {
					CURRENT_PROJECT_VERSION = 1;
					MARKETING_VERSION = 1.0;
					PRODUCT_BUNDLE_IDENTIFIER = com.calebshollow.game;
				};
				name = Debug;
			};
			504EC3181FED79650016851F /* Release */ = {
				isa = XCBuildConfiguration;
				buildSettings = {
					CURRENT_PROJECT_VERSION = 1;
					MARKETING_VERSION = 1.0;
					PRODUCT_BUNDLE_IDENTIFIER = com.calebshollow.game;
				};
				name = Release;
			};
`;

function bumpPbxproj(content, newVersion) {
  let result = content.replace(
    /MARKETING_VERSION = [^;]+;/g,
    `MARKETING_VERSION = ${newVersion};`,
  );

  const buildNumMatch = result.match(/CURRENT_PROJECT_VERSION = (\d+);/);
  const oldBuildNum = buildNumMatch ? Number(buildNumMatch[1]) : 0;
  const newBuildNum = oldBuildNum + 1;
  result = result.replace(
    /CURRENT_PROJECT_VERSION = \d+;/g,
    `CURRENT_PROJECT_VERSION = ${newBuildNum};`,
  );

  return { content: result, buildNum: newBuildNum };
}

describe('iOS pbxproj version bump', () => {
  test('replaces MARKETING_VERSION in both Debug and Release', () => {
    const { content } = bumpPbxproj(SAMPLE_PBXPROJ, '2.1.0');
    const matches = content.match(/MARKETING_VERSION = 2\.1\.0;/g);
    assert.equal(matches.length, 2, 'should replace in both configurations');
    assert.ok(!content.includes('MARKETING_VERSION = 1.0;'));
  });

  test('increments CURRENT_PROJECT_VERSION in both configurations', () => {
    const { content, buildNum } = bumpPbxproj(SAMPLE_PBXPROJ, '2.1.0');
    assert.equal(buildNum, 2);
    const matches = content.match(/CURRENT_PROJECT_VERSION = 2;/g);
    assert.equal(matches.length, 2, 'should replace in both configurations');
    assert.ok(!content.includes('CURRENT_PROJECT_VERSION = 1;'));
  });

  test('handles multi-digit build numbers', () => {
    const input = SAMPLE_PBXPROJ.replace(/CURRENT_PROJECT_VERSION = 1;/g,
      'CURRENT_PROJECT_VERSION = 99;');
    const { content, buildNum } = bumpPbxproj(input, '3.0.0');
    assert.equal(buildNum, 100);
    const matches = content.match(/CURRENT_PROJECT_VERSION = 100;/g);
    assert.equal(matches.length, 2);
  });

  test('handles semver with three parts', () => {
    const { content } = bumpPbxproj(SAMPLE_PBXPROJ, '1.3.4');
    const matches = content.match(/MARKETING_VERSION = 1\.3\.4;/g);
    assert.equal(matches.length, 2);
  });

  test('does not alter unrelated lines', () => {
    const { content } = bumpPbxproj(SAMPLE_PBXPROJ, '2.0.0');
    assert.ok(content.includes('PRODUCT_BUNDLE_IDENTIFIER = com.calebshollow.game;'));
    assert.ok(content.includes('name = Debug;'));
    assert.ok(content.includes('name = Release;'));
  });
});
