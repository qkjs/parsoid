/* ----------------------------------------------------------------------
 * This serializer is designed to eventually
 * - accept arbitrary HTML and
 * - serialize that to wikitext in a way that round-trips back to the same
 *   HTML DOM as far as possible within the limitations of wikitext.
 *
 * Not much effort has been invested so far on supporting
 * non-Parsoid/VE-generated HTML. Some of this involves adaptively switching
 * between wikitext and HTML representations based on the values of attributes
 * and DOM context. A few special cases are already handled adaptively
 * (multi-paragraph list item contents are serialized as HTML tags for
 * example, generic A elements are serialized to HTML A tags), but in general
 * support for this is mostly missing.
 *
 * Example issue:
 * <h1><p>foo</p></h1> will serialize to =\nfoo\n= whereas the
 *        correct serialized output would be: =<p>foo</p>=
 *
 * What to do about this?
 * * add a generic 'can this HTML node be serialized to wikitext in this
 *   context' detection method and use that to adaptively switch between
 *   wikitext and HTML serialization.
 * ---------------------------------------------------------------------- */

'use strict';
require('../../core-upgrade.js');

var util = require('util');

var Util = require('../utils/Util.js').Util;
var DU = require('../utils/DOMUtils.js').DOMUtils;
var Promise = require('../utils/promise.js');
var JSUtils = require('../utils/jsutils.js').JSUtils;
var wtConsts = require('../config/WikitextConstants.js');
var WTSUtils = require('./WTSUtils.js').WTSUtils;
var pd = require('../wt2html/parser.defines.js');
var ConstrainedText = require('./ConstrainedText.js').ConstrainedText;
var Normalizer = require('./normalizeDOM.js').Normalizer;
var SerializerState = require('./SerializerState.js').SerializerState;
var DOMHandlers = require('./DOMHandlers.js');
var LinkHandlersModule = require('./LinkHandler.js');
var SeparatorsModule = require('./separators.js');
var WTEModule = require('./escapeWikitext.js');

var Consts = wtConsts.WikitextConstants;
var tagHandlers = DOMHandlers.tagHandlers;
var htmlElementHandler = DOMHandlers.htmlElementHandler;
var lastItem = JSUtils.lastItem;


/**
 * Serializes a chunk of tokens or an HTML DOM to MediaWiki's wikitext flavor.
 *
 * @class
 * @constructor
 * @param {Object} options List of options for serialization
 * @param {MWParserEnvironment} options.env
 * @param {boolean} [options.rtTestMode]
 * @param {string} [options.logType="trace/wts"]
 */
function WikitextSerializer(options) {
	this.options = options;
	this.env = options.env;

	// Set rtTestMode if not already set.
	if (this.options.rtTestMode === undefined) {
		this.options.rtTestMode = this.env.conf.parsoid.rtTestMode;
	}

	// WT escaping handlers
	this.wteHandlers = new WTEModule.WikitextEscapeHandlers(this.env, this);

	this.state = new SerializerState(this, this.options);

	this.logType = this.options.logType || "trace/wts";
	this.trace = this.env.log.bind(this.env, this.logType);
}

var WSP = WikitextSerializer.prototype;

// Tag handlers
WSP._getEncapsulatedContentHandler = DOMHandlers._getEncapsulatedContentHandler;

// Used in multiple tag handlers, and hence added as top-level properties
// - linkHandler is used by <a> and <link>
// - figureHandler is used by <figure> and by <a>.linkHandler above
WSP.linkHandler = LinkHandlersModule.linkHandler;
WSP.figureHandler = LinkHandlersModule.figureHandler;

// Separator handling
WSP.handleSeparatorText = SeparatorsModule.handleSeparatorText;
WSP.updateSeparatorConstraints = SeparatorsModule.updateSeparatorConstraints;
WSP.buildSep = SeparatorsModule.buildSep;

// Methods

WSP.serializeHTML = Promise.method(function(opts, html) {
	opts.logType = this.logType;
	var body = DU.parseHTML(html).body;
	return (new WikitextSerializer(opts)).serializeDOM(body);
});

WSP.getAttributeKey = Promise.method(function(node, key) {
	var tplAttrs = DU.getDataMw(node).attribs;
	if (tplAttrs) {
		// If this attribute's key is generated content,
		// serialize HTML back to generator wikitext.
		for (var i = 0; i < tplAttrs.length; i++) {
			var a = tplAttrs[i];
			if (a[0].txt === key && a[0].html) {
				return this.serializeHTML({
					env: this.env,
					onSOL: false,
				}, a[0].html);
			}
		}
	}
	return key;
});

WSP.getAttributeValue = Promise.method(function(node, key, value) {
	var tplAttrs = DU.getDataMw(node).attribs;
	if (tplAttrs) {
		// If this attribute's value is generated content,
		// serialize HTML back to generator wikitext.
		for (var i = 0; i < tplAttrs.length; i++) {
			var a = tplAttrs[i];
			// !== null is required. html:"" will serialize to "" and will
			// be returned here. This is used to suppress the =".." string
			// in the attribute in scenarios where the template generates
			// a "k=v" string. Ex: <div {{echo|1=style='color:red'}}>foo</div>
			if (a[0] === key || a[0].txt === key && a[1].html !== null) {
				return this.serializeHTML({
					env: this.env,
					onSOL: false,
					inAttribute: true,
				}, a[1].html);
			}
		}
	}
	return value;
});

WSP.serializedAttrVal = Promise.method(function(node, name) {
	return this.serializedImageAttrVal(node, node, name);
});

WSP.serializedImageAttrVal = Promise.method(function(dataMWnode, htmlAttrNode, key) {
	return this.getAttributeValue(dataMWnode, key, null).then(function(v) {
		if (v) {
			return {
				value: v,
				modified: false,
				fromsrc: true,
				fromDataMW: true,
			};
		} else {
			return DU.getAttributeShadowInfo(htmlAttrNode, key);
		}
	});
});

WSP._serializeHTMLTag = Promise.method(function(node, wrapperUnmodified) {
	// 'inHTMLPre' flag has to be updated always,
	// even when we are selsering in the wrapperUnmodified case.
	var token = DU.mkTagTk(node);
	if (token.name === 'pre') {
		// html-syntax pre is very similar to nowiki
		this.state.inHTMLPre = true;
	}

	if (wrapperUnmodified) {
		var dsr = DU.getDataParsoid(node).dsr;
		return this.state.getOrigSrc(dsr[0], dsr[0] + dsr[2]);
	}

	var da = token.dataAttribs;
	if (da.autoInsertedStart) {
		return '';
	}

	var close = '';
	if ((Util.isVoidElement(token.name) && !da.noClose) || da.selfClose) {
		close = ' /';
	}

	return this._serializeAttributes(node, token).then(function(sAttribs) {
		if (sAttribs.length > 0) {
			sAttribs = ' ' + sAttribs;
		}

		var tokenName = da.srcTagName || token.name;
		var ret = util.format('<%s%s%s>', tokenName, sAttribs, close);

		if (tokenName.toLowerCase() === 'nowiki') {
			ret = DU.escapeNowikiTags(ret);
		}

		return ret;
	});
});

WSP._serializeHTMLEndTag = Promise.method(function(node, wrapperUnmodified) {
	if (wrapperUnmodified) {
		var dsr = DU.getDataParsoid(node).dsr;
		return this.state.getOrigSrc(dsr[1] - dsr[3], dsr[1]);
	}

	var token = DU.mkEndTagTk(node);
	if (token.name === 'pre') {
		this.state.inHTMLPre = false;
	}

	var tokenName = token.dataAttribs.srcTagName || token.name;
	var ret = '';

	if (!token.dataAttribs.autoInsertedEnd &&
			!Util.isVoidElement(token.name) &&
			!token.dataAttribs.selfClose) {
		ret = util.format('</%s>', tokenName);
	}

	if (tokenName.toLowerCase() === 'nowiki') {
		ret = DU.escapeNowikiTags(ret);
	}

	return ret;
});

var IGNORED_ATTRIBUTES = new Set([
	'data-parsoid',
	'data-ve-changed',
	'data-parsoid-changed',
	'data-parsoid-diff',
	'data-parsoid-serialize',
]);

var PARSOID_ATTRIBUTES = new Map([
	[ 'about', /^#mwt\d+$/ ],
	[ 'typeof', /(^|\s)mw:[^\s]+/g ],
]);

WSP._serializeAttributes = Promise.method(function(node, token) {
	var attribs = token.attribs;

	var out = [];
	return Promise.reduce(attribs, function(_, kv) {
		var k = kv.k;
		var v, vInfo;

		// Unconditionally ignore
		// (all of the IGNORED_ATTRIBUTES should be filtered out earlier,
		// but ignore them here too just to make sure.)
		if (IGNORED_ATTRIBUTES.has(k) || k === 'data-mw') {
			return;
		}

		// Ignore parsoid-like ids. They may have been left behind
		// by clients and shouldn't be serialized. This can also happen
		// in v2/v3 API when there is no matching data-parsoid entry found
		// for this id.
		if (k === "id" && /^mw[\w-]{2,}$/.test(kv.v)) {
			if (!node.getAttribute("data-parsoid")) {
				this.env.log("warning/html2wt",
					"Parsoid id found on element without a matching data-parsoid " +
					"entry: ID=" + kv.v + "; ELT=" + node.outerHTML);
			} else {
				vInfo = token.getAttributeShadowInfo(k);
				if (!vInfo.modified && vInfo.fromsrc) {
					out.push(k + '=' + '"' + vInfo.value.replace(/"/g, '&quot;') + '"');
				}
			}
			return;
		}

		// Strip other Parsoid-generated values
		//
		// FIXME: Given that we are currently escaping about/typeof keys
		// that show up in wikitext, we could unconditionally strip these
		// away right now.
		var parsoidValueRegExp = PARSOID_ATTRIBUTES.get(k);
		if (parsoidValueRegExp && kv.v.match(parsoidValueRegExp)) {
			v = kv.v.replace(parsoidValueRegExp, '');
			if (v) {
				out.push(k + '=' + '"' + v + '"');
			}
			return;
		}

		if (k.length > 0) {
			vInfo = token.getAttributeShadowInfo(k);
			v = vInfo.value;
			return Promise.join(
				// Deal with k/v's that were template-generated
				this.getAttributeKey(node, k),
				// Pass in kv.k, not k since k can potentially
				// be original wikitext source for 'k' rather than
				// the string value of the key.
				this.getAttributeValue(node, kv.k, v)
			).spread(function(kk, vv) {
				// Remove encapsulation from protected attributes
				// in pegTokenizer.pegjs.txt:generic_newline_attribute
				kk = kk.replace(/^data-x-/i, '');
				if (vv.length > 0) {
					if (!vInfo.fromsrc) {
						// Escape HTML entities
						vv = Util.escapeEntities(vv);
					}
					out.push(kk + '=' + '"' + vv.replace(/"/g, '&quot;') + '"');
				} else if (kk.match(/[{<]/)) {
					// Templated, <*include*>, or <ext-tag> generated
					out.push(kk);
				} else {
					out.push(kk + '=""');
				}
				return;
			});
		} else if (kv.v.length) {
			// not very likely..
			out.push(kv.v);
		}

		return;
	}.bind(this), null).then(function() {
		// SSS FIXME: It can be reasonably argued that we can permanently delete
		// dangerous and unacceptable attributes in the interest of safety/security
		// and the resultant dirty diffs should be acceptable.  But, this is
		// something to do in the future once we have passed the initial tests
		// of parsoid acceptance.
		//
		// 'a' data attribs -- look for attributes that were removed
		// as part of sanitization and add them back
		var dataAttribs = token.dataAttribs;
		if (dataAttribs.a && dataAttribs.sa) {
			var aKeys = Object.keys(dataAttribs.a);
			for (var i = 0, l = aKeys.length; i < l; i++) {
				var k = aKeys[i];
				// Attrib not present -- sanitized away!
				if (!Util.lookupKV(attribs, k)) {
					var v = dataAttribs.sa[k];
					if (v) {
						out.push(k + '=' + '"' + v.replace(/"/g, '&quot;') + '"');
					} else {
						// at least preserve the key
						out.push(k);
					}
				}
			}
		}
		// XXX: round-trip optional whitespace / line breaks etc
		return out.join(' ');
	});
});

WSP._handleLIHackIfApplicable = function(node) {
	var liHackSrc = DU.getDataParsoid(node).liHackSrc;
	var prev = DU.previousNonSepSibling(node);

	// If we are dealing with an LI hack, then we must ensure that
	// we are dealing with either
	//
	//   1. A node with no previous sibling inside of a list.
	//
	//   2. A node whose previous sibling is a list element.
	if (liHackSrc !== undefined &&
			((prev === null && DU.isList(node.parentNode)) ||       // Case 1
			(prev !== null && DU.isListItem(prev)))) {              // Case 2
		this.state.emitChunk(liHackSrc, node);
	}
};

WSP._buildTemplateWT = Promise.method(function(node, srcParts) {
	function countPositionalArgs(tpl, paramInfos) {
		var res = 0;
		paramInfos.forEach(function(paramInfo) {
			var k = paramInfo.k;
			if (tpl.params[k] !== undefined && !paramInfo.named) {
				res++;
			}
		});
		return res;
	}

	var self = this;
	var env = this.env;
	var dp = DU.getDataParsoid(node);

	var buf = '';
	return Promise.reduce(srcParts, function(_, part) {
		var tpl = part.template;
		if (!tpl) {
			buf += part;
			return;
		}
		// transclusion: tpl or parser function

		var isTpl = typeof (tpl.target.href) === 'string';
		buf += "{{";

		// tpl target
		buf += tpl.target.wt;

		// tpl args
		var keys = Object.keys(tpl.params);

		// per-parameter info for pre-existing parameters
		var paramInfos = dp.pi && tpl.i !== undefined ?
				dp.pi[tpl.i] || [] : [];

		// extract the original keys in order
		var origKeys = paramInfos.map(function(paramInfo) {
			return paramInfo.k;
		});

		var n = keys.length;
		if (!n) {
			buf += '}}';
			return;
		}

		var argIndex = 1;
		var numericIndex = 1;
		var numPositionalArgs = countPositionalArgs(tpl, paramInfos);

		var pushArg = Promise.method(function(argBuf, k, paramInfo) {
			if (!paramInfo) {
				paramInfo = {};
			}

			var escapedValue;
			var paramName;
			// Default to ' = ' spacing. Anything that matches
			// this does not remember spc explicitly.
			var spc = ['', ' ', ' ', ''];
			var opts = {
				serializeAsNamed: false,
				isTemplate: isTpl,
				argPositionalIndex: numericIndex,
				numPositionalArgs: numPositionalArgs,
				argIndex: argIndex++,
				numArgs: n,
			};

			if (paramInfo.named || k !== numericIndex.toString()) {
				opts.serializeAsNamed = true;
			}

			// TODO: Other formats?
			// Only consider the html parameter if the wikitext one
			// isn't present at all. If it's present but empty that's
			// still considered a valid parameter.
			var p;
			if (tpl.params[k].wt !== undefined) {
				p = Promise.resolve(tpl.params[k].wt);
			} else {
				p = self.serializeHTML(
					{ env: env },
					tpl.params[k].html
				);
			}
			return p.then(function(value) {
				if (typeof value !== "string") {
					env.log("error/html2wt/spec",
						"For param: ", k,
						", wt property should be a string but got: ",
						value);
					// This is a temporary fix. Once T90463 is fixed,
					// we should log the error above, and maybe return
					// an error to VE. In any case, we shouldn't be
					// crashing. See T90479.
					value = Util.tokensToString(value);
				}

				escapedValue = self.wteHandlers.escapeTplArgWT(value, opts);

				if (paramInfo.spc) {
					spc = paramInfo.spc;
				} else if (opts.serializeAsNamed && k === "") {
					// No spacing for blank parameters ({{foo|=bar}})
					spc = ['', '', '', ''];
				} // else {
				// TODO: match the space style of other/ parameters!
				// spc = ['', ' ', ' ', ''];
				// }

				// The name is usually equal to the parameter key, but
				// if there's a key.wt attribute, use that.
				if (tpl.params[k].key && tpl.params[k].key.wt !== undefined) {
					paramName = tpl.params[k].key.wt;
					// And make it appear even if there wasn't
					// data-parsoid information.
					escapedValue.serializeAsNamed = true;
				} else {
					paramName = k;
				}

				if (escapedValue.serializeAsNamed) {
					// Escape as value only
					// Trim WS
					argBuf.push(spc[0] + paramName + spc[1] + "=" +
						spc[2] + escapedValue.v.trim() + spc[3]);
				} else {
					numericIndex++;
					// Escape as positional parameter
					// No WS trimming
					argBuf.push(escapedValue.v);
				}
				return argBuf;
			});
		});

		// first serialize out old parameters in order
		var argBuf = [];
		return Promise.reduce(paramInfos, function(__, paramInfo) {
			var k = paramInfo.k;
			if (tpl.params[k] !== undefined) {
				return pushArg(argBuf, k, paramInfo);
			}
		}, null).then(function() {
			// then push out remaining (new) parameters
			return Promise.reduce(keys, function(_, k) {
				// Don't allow whitespace in keys
				var strippedK = k.trim();
				if (origKeys.indexOf(strippedK) === -1) {
					if (strippedK !== k) {
						// copy over
						tpl.params[strippedK] = tpl.params[k];
					}
					return pushArg(argBuf, strippedK);
				}
			}, null);
		}).then(function() {
			// Now append the parameters joined by pipes
			buf += '|';
			buf += argBuf.join('|');
			buf += '}}';
		});
	}, null).then(function() { return buf; });
});

WSP.defaultExtensionHandler = Promise.method(function(node, dataMW) {
	var extName = dataMW.name;
	var srcParts = ["<", extName];
	var env = this.env;

	// Serialize extension attributes in normalized form as:
	// key='value'
	// FIXME: with no dataAttribs, shadow info will mark it as new
	var attrs = dataMW.attrs || {};
	var extTok = new pd.TagTk(extName, Object.keys(attrs).map(function(k) {
		return new pd.KV(k, attrs[k]);
	}));
	var about = node.getAttribute('about');
	var type = node.getAttribute('typeof');

	if (about) {
		extTok.addAttribute('about', about);
	}
	if (type) {
		extTok.addAttribute('typeof', type);
	}

	return this._serializeAttributes(node, extTok).then(function(attrStr) {
		if (attrStr) {
			srcParts.push(' ');
			srcParts.push(attrStr);
		}

		// Serialize body
		if (!dataMW.body) {
			srcParts.push(" />");
			return;
		}

		srcParts.push(">");

		var p;
		if (typeof dataMW.body.html === 'string' ||
				typeof dataMW.body.id === 'string') {
			var htmlText;
			// First look for the extension's content in data-mw.body.html
			if (dataMW.body.html) {
				htmlText = dataMW.body.html;
			} else {
				// If the body isn't contained in data-mw.body.html, look if
				// there's an element pointed to by body.id.
				var bodyElt = node.ownerDocument.getElementById(dataMW.body.id);
				if (!bodyElt && env.page.editedDoc) {
					// Try to get to it from the main page.
					// This can happen when the <ref> is inside another extension,
					// most commonly inside a <references>.
					bodyElt = env.page.editedDoc.getElementById(dataMW.body.id);
				}
				if (bodyElt) {
					htmlText = bodyElt.innerHTML;
				} else {
					// Some extra debugging for VisualEditor
					var extraDebug = '';
					var firstA = node.querySelector('a[href]');
					if (firstA && /^#/.test(firstA.getAttribute('href'))) {
						var href = firstA.getAttribute('href');
						var ref = node.ownerDocument.querySelector(href);
						if (ref) {
							extraDebug += ' [own doc: ' + ref.outerHTML + ']';
						}
						ref = env.page.editedDoc.querySelector(href);
						if (ref) {
							extraDebug += ' [main doc: ' + ref.outerHTML + ']';
						}
						if (!extraDebug) {
							extraDebug = ' [reference ' + href + ' not found]';
						}
					}

					// Log an error and drop the extension call
					env.log("error/" + extName,
						"extension src id " + dataMW.body.id +
						" points to non-existent element for:", node.outerHTML,
						". Dropping the extension. More debug info: ",
						extraDebug);
					srcParts = [];
					return;
				}
			}
			if (htmlText) {
				p = this.serializeHTML({
					env: env,
					extName: extName,
				}, htmlText).then(function(res) {
					srcParts.push(res);
				});
			} else {
				p = Promise.resolve();
			}
		} else if (dataMW.body.extsrc !== null &&
				dataMW.body.extsrc !== undefined) {
			srcParts.push(dataMW.body.extsrc);
			p = Promise.resolve();
		} else {
			env.log("error",
				"extension src unavailable for: " + node.outerHTML);
			p = Promise.resolve();
		}

		return p.then(function() {
			srcParts = srcParts.concat(["</", extName, ">"]);
		});
	}.bind(this)).then(function() {
		return srcParts.join('');
	});
});

/**
 * Get a `domHandler` for an element node.
 */
WSP._getDOMHandler = function(node) {
	if (!node || !DU.isElt(node)) { return {}; }

	var handler = this._getEncapsulatedContentHandler(node);
	if (handler !== null) { return handler; }

	var dp = DU.getDataParsoid(node);
	var nodeName = node.nodeName.toLowerCase();

	// If available, use a specialized handler for serializing
	// to the specialized syntactic form of the tag.
	handler = tagHandlers.get(nodeName + '_' + dp.stx);

	// Unless a specialized handler is available, use the HTML handler
	// for html-stx tags. But, <a> tags should never serialize as HTML.
	if (!handler && dp.stx === 'html' && nodeName !== 'a') {
		return htmlElementHandler;
	}

	// If parent node is a list or table tag in html-syntax, then serialize
	// new elements in html-syntax rather than wiki-syntax.
	if (DU.isNewElt(node) && !DU.atTheTop(node) &&
		!DU.isDocumentFragment(node.parentNode) &&
		DU.getDataParsoid(node.parentNode).stx === 'html' &&
		((DU.isList(node.parentNode) && DU.isListItem(node)) ||
			(Consts.ParentTableTags.has(node.parentNode.nodeName) &&
			Consts.ChildTableTags.has(node.nodeName)))) {
		return htmlElementHandler;
	}

	// Pick the best available handler
	return handler || tagHandlers.get(nodeName) || htmlElementHandler;
};

WSP.separatorREs = {
	pureSepRE: /^\s*$/,
	sepPrefixWithNlsRE: /^[ \t]*\n+\s*/,
	sepSuffixWithNlsRE: /\n\s*$/,
	doubleNewlineRE_G: /\n([ \t]*\n)+/g,
};

/**
 * Serialize the content of a text node
 */
WSP._serializeTextNode = Promise.method(function(node) {
	var res = node.nodeValue;
	var state = this.state;

	var doubleNewlineMatch = res.match(this.separatorREs.doubleNewlineRE_G);
	var doubleNewlineCount = doubleNewlineMatch && doubleNewlineMatch.length || 0;

	// Deal with trailing separator-like text (at least 1 newline and other whitespace)
	var newSepMatch = res.match(this.separatorREs.sepSuffixWithNlsRE);
	res = res.replace(this.separatorREs.sepSuffixWithNlsRE, '');

	if (!state.inIndentPre) {
		// Don't strip two newlines for wikitext like this:
		// <div>foo
		//
		// bar</div>
		// The PHP parser won't create paragraphs on lines that also contain
		// block-level tags.
		if (!state.inHTMLPre && (!DU.allChildrenAreText(node.parentNode) ||
			doubleNewlineCount !== 1)) {
			// Strip more than one consecutive newline
			res = res.replace(this.separatorREs.doubleNewlineRE_G, '\n');
		}

		// Strip leading newlines and other whitespace
		// They are already added to the separator source in handleSeparatorText.
		res = res.replace(this.separatorREs.sepPrefixWithNlsRE, '');
	}

	// Always escape entities
	res = Util.escapeEntities(res);

	// If not in nowiki and pre context, escape wikitext
	// XXX refactor: Handle this with escape handlers instead!
	state.escapeText = (state.onSOL || !state.currNodeUnmodified) &&
			!state.inNoWiki && !state.inHTMLPre;
	state.emitChunk(res, node);
	state.escapeText = false;

	// Move trailing newlines into the next separator
	if (newSepMatch) {
		if (!state.sep.src) {
			state.setSep(newSepMatch[0]);
			state.updateSep(node);
		} else {
			/* SSS FIXME: what are we doing with the stripped NLs?? */
		}
	}
});

/**
 * Emit non-separator wikitext that does not need to be escaped
 */
WSP.emitWikitext = function(text, node) {
	var state = this.state;

	// Strip leading newlines.
	// They are already added to the separator source in handleSeparatorText.
	var res = text.replace(this.separatorREs.sepPrefixWithNlsRE, '');

	// Deal with trailing newlines
	var newSepMatch = res.match(this.separatorREs.sepSuffixWithNlsRE);
	res = res.replace(this.separatorREs.sepSuffixWithNlsRE, '');

	state.emitChunk(res, node);

	// Move trailing newlines into the next separator
	if (newSepMatch) {
		if (!state.sep.src) {
			state.setSep(newSepMatch[0]);
			state.updateSep(node);
		} else {
			/* SSS FIXME: what are we doing with the stripped NLs?? */
		}
	}
};

WSP._getDOMAttribs = function(attribs) {
	// convert to list of key-value pairs
	var out = [];
	for (var i = 0, l = attribs.length; i < l; i++) {
		var attrib = attribs.item(i);
		if (!IGNORED_ATTRIBUTES.has(attrib.name)) {
			out.push({ k: attrib.name, v: attrib.value });
		}
	}
	return out;
};

// DOM-based serialization
WSP._serializeDOMNode = Promise.method(function(node, domHandler) {
	// To serialize a node from source, the node should satisfy these
	// conditions:
	//
	// 1. It should not have a diff marker or be in a modified subtree
	//    WTS should not be in a subtree with a modification flag that
	//    applies to every node of a subtree (rather than an indication
	//    that some node in the subtree is modified).
	//
	// 2. It should continue to be valid in any surrounding edited context
	//    For some nodes, modification of surrounding context
	//    can change serialized output of this node
	//    (ex: <td>s and whether you emit | or || for them)
	//
	// 3. It should have valid, usable DSR
	//
	// 4. Either it has non-zero positive DSR width, or meets one of the
	//    following:
	//
	//    4a. It is content like <p><br/><p> or an automatically-inserted
	//        wikitext <references/> (HTML <ol>) (will have dsr-width 0)
	//    4b. it is fostered content (will have dsr-width 0)
	//    4c. it is misnested content (will have dsr-width 0)
	//
	// SSS FIXME: Additionally, we can guard against buggy DSR with
	// some sanity checks. We can test that non-sep src content
	// leading wikitext markup corresponds to the node type.
	//
	// Ex: If node.nodeName is 'UL', then src[0] should be '*'
	//
	// TO BE DONE

	var state = this.state;
	var wrapperUnmodified = false;
	var dp = DU.getDataParsoid(node);

	dp.dsr = dp.dsr || [];

	if (state.selserMode
			&& !state.inModifiedContent
			&& DU.origSrcValidInEditedContext(state.env, node)
			&& dp && Util.isValidDSR(dp.dsr)
			&& (dp.dsr[1] > dp.dsr[0]
				// FIXME: <p><br/></p>
				// nodes that have dsr width 0 because currently,
				// we emit newlines outside the p-nodes. So, this check
				// tries to handle that scenario.
				// Zero-width <ol> corresponds to automatically-inserted
				// <references/> nodes.
			|| (dp.dsr[1] === dp.dsr[0] && /^(P|BR|OL)$/.test(node.nodeName))
			|| dp.fostered || dp.misnested)) {

		if (!DU.hasDiffMarkers(node, this.env)) {
			// If this HTML node will disappear in wikitext because of
			// zero width, then the separator constraints will carry over
			// to the node's children.
			//
			// Since we dont recurse into 'node' in selser mode, we update the
			// separator constraintInfo to apply to 'node' and its first child.
			//
			// We could clear constraintInfo altogether which would be
			// correct (but could normalize separators and introduce dirty
			// diffs unnecessarily).

			state.currNodeUnmodified = true;

			if (DU.isZeroWidthWikitextElt(node) &&
				node.childNodes.length > 0 &&
				state.sep.constraints.constraintInfo.sepType === 'sibling') {
				state.sep.constraints.constraintInfo.onSOL = state.onSOL;
				state.sep.constraints.constraintInfo.sepType = 'parent-child';
				state.sep.constraints.constraintInfo.nodeA = node;
				state.sep.constraints.constraintInfo.nodeB = node.firstChild;
			}

			var out = state.getOrigSrc(dp.dsr[0], dp.dsr[1]);

			this.trace("ORIG-src with DSR", function() {
				return '[' + dp.dsr[0] + ',' + dp.dsr[1] + '] = ' + JSON.stringify(out);
			});

			// When reusing source, we should only suppress serializing
			// to a single line for the cases we've whitelisted in
			// normal serialization.
			var suppressSLC = DU.isFirstEncapsulationWrapperNode(node) ||
					['DL', 'UL', 'OL'].indexOf(node.nodeName) > -1 ||
					(node.nodeName === 'TABLE' &&
						node.parentNode.nodeName === 'DD' &&
						DU.previousNonSepSibling(node) === null);

			// Use selser to serialize this text!  The original
			// wikitext is `out`.  But first allow
			// `ConstrainedText.fromSelSer` to figure out the right
			// type of ConstrainedText chunk(s) to use to represent
			// `out`, based on the node type.  Since we might actually
			// have to break this wikitext into multiple chunks,
			// `fromSelSer` returns an array.
			if (suppressSLC) { state.singleLineContext.disable(); }
			ConstrainedText
					.fromSelSer(out, node, dp, state.env)
					.forEach(function(ct) {
				state.emitChunk(ct, ct.node);
			});
			if (suppressSLC) { state.singleLineContext.pop(); }

			// Skip over encapsulated content since it has already been
			// serialized.
			if (DU.isFirstEncapsulationWrapperNode(node)) {
				return DU.skipOverEncapsulatedContent(node);
			} else {
				return node.nextSibling;
			}
		}

		if (DU.onlySubtreeChanged(node, this.env) &&
				WTSUtils.hasValidTagWidths(dp.dsr) &&
				// In general, we want to avoid nodes with auto-inserted
				// start/end tags since dsr for them might not be entirely
				// trustworthy. But, since wikitext does not have closing tags
				// for tr/td/th in the first place, dsr for them can be trusted.
				//
				// SSS FIXME: I think this is only for b/i tags for which we do
				// dsr fixups. It may be okay to use this for other tags.
				((!dp.autoInsertedStart && !dp.autoInsertedEnd) ||
				/^(TD|TH|TR)$/.test(node.nodeName))) {
			wrapperUnmodified = true;
		}
	}

	state.currNodeUnmodified = false;

	var inModifiedContent = state.selserMode &&
			DU.hasInsertedDiffMark(node, this.env);

	if (inModifiedContent) { state.inModifiedContent = true; }
	return domHandler
			.handle(node, state, wrapperUnmodified)
			.then(function(next) {
		if (inModifiedContent) { state.inModifiedContent = false; }
		return next;
	});
});

/**
 * Internal worker. Recursively serialize a DOM subtree.
 */
WSP._serializeNode = Promise.method(function(node) {
	var prev, domHandler, method;
	var state = this.state;

	if (state.selserMode) {
		this.trace(function() { return WTSUtils.traceNodeName(node); },
			"; prev-unmodified: ", state.prevNodeUnmodified,
			"; SOL: ", state.onSOL);
	} else {
		this.trace(function() { return WTSUtils.traceNodeName(node); },
			"; SOL: ", state.onSOL);
	}

	switch (node.nodeType) {
	case node.ELEMENT_NODE:
		// Ignore DiffMarker metas, but clear unmodified node state
		if (DU.isMarkerMeta(node, "mw:DiffMarker")) {
			state.sep.lastSourceNode = node;
			// Update modification flags
			state.updateModificationFlags(node);
			return node.nextSibling;
		}
		domHandler = this._getDOMHandler(node);
		console.assert(domHandler && domHandler.handle,
			'No dom handler found for', node.outerHTML);
		method = this._serializeDOMNode;
		break;
	case node.TEXT_NODE:
		if (this.handleSeparatorText(node)) {
			return node.nextSibling;
		}
		if (state.selserMode) {
			prev = node.previousSibling;
			if (!state.inModifiedContent && (
				(!prev && DU.isBody(node.parentNode)) ||
				(prev && !DU.isMarkerMeta(prev, "mw:DiffMarker")))
				) {
				state.currNodeUnmodified = true;
			} else {
				state.currNodeUnmodified = false;
			}
		}
		domHandler = {};
		method = this._serializeTextNode;
		break;
	case node.COMMENT_NODE:
		// Merge this into separators
		state.setSep((state.sep.src || '') + WTSUtils.commentWT(node.nodeValue));
		return node.nextSibling;
	default:
		console.assert("Unhandled node type:", node.outerHTML);
	}

	prev = DU.previousNonSepSibling(node) || node.parentNode;
	this.updateSeparatorConstraints(
			prev, this._getDOMHandler(prev),
			node, domHandler);

	return method.call(this, node, domHandler).then(function(nextNode) {
		var next = DU.nextNonSepSibling(node) || node.parentNode;
		this.updateSeparatorConstraints(
				node, domHandler,
				next, this._getDOMHandler(next));

		// Update modification flags
		state.updateModificationFlags(node);

		// If handlers didn't provide a valid next node,
		// default to next sibling.
		if (nextNode === undefined) {
			nextNode = node.nextSibling;
		}
		return nextNode;
	}.bind(this));
});

WSP._stripUnnecessaryIndentPreNowikis = function() {
	var env = this.env;
	// FIXME: The solTransparentWikitextRegexp includes redirects, which really
	// only belong at the SOF and should be unique. See the "New redirect" test.
	var noWikiRegexp = new RegExp(
		'^' + env.conf.wiki.solTransparentWikitextNoWsRegexp.source +
		'(<nowiki>\\s+</nowiki>)([^\n]*(?:\n|$))', 'im'
	);
	var pieces = this.state.out.split(noWikiRegexp);
	var out = pieces[0];
	for (var i = 1; i < pieces.length; i += 4) {
		out += pieces[i];
		var nowiki = pieces[i + 1];
		var rest = pieces[i + 2];
		// Ignore comments
		var htmlTags = rest.match(/<[^!][^<>]*>/g) || [];

		// Not required if just sol transparent wt.
		var reqd = !env.conf.wiki.solTransparentWikitextRegexp.test(rest);

		if (reqd) {
			for (var j = 0; j < htmlTags.length; j++) {
				// Strip </, attributes, and > to get the tagname
				var tagName = htmlTags[j].replace(/<\/?|\s.*|>/g, '').toUpperCase();
				if (!Consts.HTML.HTML5Tags.has(tagName)) {
					// If we encounter any tag that is not a html5 tag,
					// it could be an extension tag. We could do a more complex
					// regexp or tokenize the string to determine if any block tags
					// show up outside the extension tag. But, for now, we just
					// conservatively bail and leave the nowiki as is.
					reqd = true;
					break;
				} else if (Consts.HTML.BlockTags.has(tagName)) {
					// Block tags on a line suppress nowikis
					reqd = false;
				}
			}
		}

		if (!reqd) {
			nowiki = nowiki.replace(/^<nowiki>(\s+)<\/nowiki>/, '$1');
		} else if (env.scrubWikitext) {
			nowiki = nowiki.replace(/^<nowiki>(\s+)<\/nowiki>/, '');
			rest = rest.replace(/^\s*/, '');
		}
		out = out + nowiki + rest + pieces[i + 3];
	}
	this.state.out = out;
};

// This implements a heuristic to strip two common sources of <nowiki/>s.
// When <i> and <b> tags are matched up properly,
// - any single ' char before <i> or <b> does not need <nowiki/> protection.
// - any single ' char before </i> or </b> does not need <nowiki/> protection.
WSP._stripUnnecessaryQuoteNowikis = function() {
	this.state.out = this.state.out.split(/\n|$/).map(function(line) {
		// Optimization: We are interested in <nowiki/>s before quote chars.
		// So, skip this if we don't have both.
		if (!(/<nowiki\s*\/>/.test(line) && /'/.test(line))) {
			return line;
		}

		// * Split out all the [[ ]] {{ }} '' ''' ''''' <..> </...>
		//   parens in the regexp mean that the split segments will
		//   be spliced into the result array as the odd elements.
		// * If we match up the tags properly and we see opening
		//   <i> / <b> / <i><b> tags preceded by a '<nowiki/>, we
		//   can remove all those nowikis.
		//   Ex: '<nowiki/>''foo'' bar '<nowiki/>'''baz'''
		// * If we match up the tags properly and we see closing
		//   <i> / <b> / <i><b> tags preceded by a '<nowiki/>, we
		//   can remove all those nowikis.
		//   Ex: ''foo'<nowiki/>'' bar '''baz'<nowiki/>'''
		var p = line.split(/('''''|'''|''|\[\[|\]\]|\{\{|\}\}|<\w+(?:\s+[^>]*?|\s*?)\/?>|<\/\w+\s*>)/);

		// Which nowiki do we strip out?
		var nowikiIndex = -1;

		// Verify that everything else is properly paired up.
		var stack = [];
		var quotesOnStack = 0;
		var n = p.length;
		var nowiki = false;
		var ref = false;
		for (var j = 1; j < n; j += 2) {
			// For HTML tags, pull out just the tag name for clearer code below.
			var tag = (/^<(\/?\w+)/.exec(p[j]) || '')[1] || p[j];
			var selfClose = false;
			if (/\/>$/.test(p[j])) { tag += '/'; selfClose = true; }
			// Ignore <ref>..</ref> sections
			if (tag === 'ref') { ref = true; continue; }
			if (ref) {
				if (tag === '/ref') { ref = false; }
				continue;
			}

			// Ignore <nowiki>..</nowiki> sections
			if (tag === 'nowiki') { nowiki = true; continue; }
			if (nowiki) {
				if (tag === '/nowiki') { nowiki = false; }
				continue;
			}

			if (tag === ']]') {
				if (stack.pop() !== '[[') { return line; }
			} else if (tag === '}}') {
				if (stack.pop() !== '{{') { return line; }
			} else if (tag[0] === '/') { // closing html tag
				// match html/ext tags
				var opentag = stack.pop();
				if (tag !== ('/' + opentag)) {
					return line;
				}
			} else if (tag === 'nowiki/') {
				// We only want to process:
				// - trailing single quotes (bar')
				// - or single quotes by themselves without a preceding '' sequence
				if (/'$/.test(p[j - 1]) && !(p[j - 1] === "'" && /''$/.test(p[j - 2])) &&
					// Consider <b>foo<i>bar'</i>baz</b> or <b>foo'<i>bar'</i>baz</b>.
					// The <nowiki/> before the <i> or </i> cannot be stripped
					// if the <i> is embedded inside another quote.
					(quotesOnStack === 0
					// The only strippable scenario with a single quote elt on stack
					// is: ''bar'<nowiki/>''
					//   -> ["", "''", "bar'", "<nowiki/>", "", "''"]
					|| (quotesOnStack === 1
						&& j + 2 < n
						&& p[j + 1] === ""
						&& p[j + 2][0] === "'"
						&& p[j + 2] === lastItem(stack))
					)) {
					nowikiIndex = j;
				}
				continue;
			} else if (selfClose || tag === "br") {
				// Skip over self-closing tags or what should have been self-closed.
				// ( While we could do this for all void tags defined in
				//   mediawiki.wikitext.constants.js, <br> is the most common
				//   culprit. )
				continue;
			} else if (tag[0] === "'" && lastItem(stack) === tag) {
				stack.pop();
				quotesOnStack--;
			} else {
				stack.push(tag);
				if (tag[0] === "'") { quotesOnStack++; }
			}
		}

		if (stack.length) { return line; }

		if (nowikiIndex !== -1) {
			// We can only remove the final trailing nowiki.
			//
			// HTML  : <i>'foo'</i>
			// line  : ''<nowiki/>'foo'<nowiki/>''
			p[nowikiIndex] = '';
			return p.join('');
		} else {
			return line;
		}
	}).join("\n");
};

/**
 * Serialize an HTML DOM document.
 * WARNING: You probably want to use DU.serializeDOM instead.
 */
WSP.serializeDOM = Promise.method(function(body, selserMode) {
	console.assert(DU.isBody(body), 'Expected a body node.');

	this.logType = selserMode ? "trace/selser" : "trace/wts";
	this.trace = this.env.log.bind(this.env, this.logType);

	if (!this.env.page.editedDoc) {
		this.env.page.editedDoc = body.ownerDocument;
	}

	var state = this.state;
	state.initMode(selserMode);

	// Normalize the DOM
	(new Normalizer(state)).normalizeDOM(body);

	// Don't serialize the DOM if debugging is disabled
	this.trace(function() {
		return "--- DOM --- \n" + body.outerHTML + "\n-----------";
	});

	state.updateSep(body);
	state.resetCurrLine(body.firstChild);

	return state.serializeChildren(body).then(function() {
		// Emit child-parent seps.
		state.emitChunk('', body);
		// We've reached EOF, flush the remaining buffered text.
		state.flushLine();

		if (state.hasIndentPreNowikis) {
			// FIXME: Perhaps this can be done on a per-line basis
			// rather than do one post-pass on the entire document.
			//
			// Strip excess/useless nowikis
			this._stripUnnecessaryIndentPreNowikis();
		}

		if (state.hasQuoteNowikis) {
			// FIXME: Perhaps this can be done on a per-line basis
			// rather than do one post-pass on the entire document.
			//
			// Strip excess/useless nowikis
			this._stripUnnecessaryQuoteNowikis();
		}

		if (state.hasSelfClosingNowikis || state.selserMode) {
			// Strip (useless) trailing <nowiki/>s
			// Interim fix till we stop introducing them in the first place.
			//
			// Don't strip |param = <nowiki/> since that pattern is used
			// in transclusions and where the trailing <nowiki /> is a valid
			// template arg. So, use a conservative regexp to detect that usage.
			state.out = state.out.split('\n').map(function(piece) {
				return piece.replace(/^([^=]*?)(?:<nowiki\s*\/>\s*)+$/, '$1');
			}).join('\n');
		}

		return state.out;
	}.bind(this));
});


if (typeof module === "object") {
	module.exports.WikitextSerializer = WikitextSerializer;
}
