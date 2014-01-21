'use strict';

var async   = require('async'),
    fs      = require('fs'),
    path    = require('path'),
    request = require('request'),
    phantom = require('phantomjs'),
    _       = require('underscore');

/**
 * Run a page through phantomjs
 * @param  {String}   filename The name of the HTML page
 * @param  {Number}   timeout  How much to wait for JS evaluation
 * @param  {Function} callback
 * @return {String}            The contents of the files, as seen by Phantom
 */
function phantom_eval(filename, timeout, callback) {
    var childArgs = [
            path.join(__dirname, 'phantom-script.js'),
            filename,
            timeout
        ];

    require('child_process').execFile(phantom.path, childArgs, function (err, stdout, stderr) {
        /* Filter OSX-specific error */
        var isNot192OSXError = (err || stderr || '').indexOf('WARNING: Method userSpaceScaleFactor') === -1,
            isNotPerformanceNote = (err || stderr || '').indexOf('CoreText performance note:') === -1;

        /* istanbul ignore if: not testable */
        if (err) {
            if (isNot192OSXError && isNotPerformanceNote) {
                return callback(err);
            }
        }
        /* istanbul ignore if: not testable */
        if (stderr) {
            /* Our error */
            if (isNot192OSXError && isNotPerformanceNote) {
                return callback(stderr);
            }
        }
        /* Success */
        return callback(null, stdout);
    });
}

/**
 * Given an array of filenames, return an array of the files' contents,
 *   only if the filename matches a regex
 * @param {Array} files An array of the filenames to read
 * @param {Function} callback
 */
function mapReadFiles(files, callback) {
    return async.map(files, function (filename, done) {
        if (filename.match(/^http/)) {
            request(
                filename,
                { headers: {'User-Agent': 'UnCSS'} },
                function (err, res, body) {
                    if (err) {
                        return done(err);
                    }
                    return done(null, body);
                }
            );
        } else {
            if (fs.existsSync(filename)) {
                return fs.readFile(filename, 'utf8', done);
            }
            return done('Error - could not open: ' + path.join(process.cwd(), filename));
        }
    }, callback);
}

/**
 * Extract stylesheets' hrefs from dom
 * @param  {Array}  dom     List of DOMs loaded by cheerio
 * @param  {Object} options Options, as passed to UnCSS
 * @return {Array}          Array of hrefs
 */
function extractStylesheets(dom, options) {
    var media = _.union(['screen', 'all'], options.media),
        stylesheets;

    /* Match only specified media attributes, plus defaults */
    media = 'link[rel="stylesheet"]:not(media),' + media.map(function (selector) {
        return 'link[rel="stylesheet"]' + '[media="' + selector + '"]';
    }).join(', ');

    stylesheets = dom(media);

    /* Stylesheets is not an array, but an object whose elements are indexes */
    return _.toArray(stylesheets).map(function (x) {
        return x.attribs.href;
    });
}

/**
 * Private function used in filterUnusedRules.
 * @param  {Object} doms      List of DOMs loaded by cheerio
 * @param  {Array}  selectors CSS selectors created by the CSS parser
 * @param  {Array}  ignore    List of selectors to be ignored
 * @return {Array}            The selectors matched in the DOMs
 */
function filterUnusedSelectors(doms, selectors, ignore) {
    /* There are some selectors not supported for matching, like
     *   :before, :after
     * They should be removed only if the parent is not found.
     * Example: '.clearfix:before' should be removed only if there
     *          is no '.clearfix'
     */
    return selectors.filter(function (selector) {
        var match, i, j, temp;
        /* Don't process @-rules (for now?) */
        if (selector[0] === '@') {
            return true;
        }
        if (ignore.indexOf(selector) !== -1) {
            return true;
        }
        // Issue #7 check regex ignores
        for (j = 0; j < ignore.length; ++j) {
            // if ignore is RegExp and matches selector ...
            if (_.isRegExp(ignore[j]) && ignore[j].test(selector)) {
                return true;
            }
        }

        /* For each DOM, match the selector */
        for (i = 0; i < doms.length; ++i) {
            /* Another way would be to list all the unsupported pseudos */
            try {
                match = doms[i](selector);
            } catch (e) {
                /* Remove ':' pseudos. */
                temp =
                    selector
                    /* Remove comments */
                    .replace(/\/\*.*?\*\//)
                    /* Ignore quoted spaces (a:hover > [class*=" icon-"])
                     *                                          ^        */
                    .match(/(?:[^\s"]+|"[^"]*")+/g)
                    /* Ignore quoted ':' (a[href="javascript:"]:hover)
                     *                                      ^         */
                    .map(function (str) {
                        return str.match(/(?:[^ :"]+|"[^"]*")+/g)[0];
                    }).join(' ');
                /* istanbul ignore next: need examples */
                try {
                    match = doms[i](temp);
                } catch(e) {
                    /* Gracefully give up */
                    return true;
                }
            }
            if (match.length !== 0) {
                return true;
            }
        }
        return false;
    });
}

/**
 * Remove css rules not used in the dom
 * @param  {Object} doms       List of DOMs loaded by cheerio
 * @param  {Object} stylesheet The output of css.parse().stylesheet
 * @param  {Array}  ignore     List of selectors to be ignored
 * @return {Array}             The rules matched in the dom
 */
function filterUnusedRules(doms, stylesheet, ignore) {
    var rules = stylesheet.rules;
    /* Rule format:
     *  { selectors: [ '...', '...' ],
     *    declarations: [ { property: '...', value: '...' } ]
     *  },
     * Two steps: filter the unused selectors for each rule,
     *            filter the rules with no selectors
     */
    rules.forEach(function (rule) {
        if (rule.type === 'rule') {
            rule.selectors =
                filterUnusedSelectors(doms, rule.selectors, ignore);
        } else if (rule.type === 'media') {
            /* Recurse */
            rule.rules = filterUnusedRules(
                doms,
                { rules: rule.rules },
                ignore
            ).stylesheet.rules;
        }
    });

    rules = rules.filter(function (rule) {
        /* Filter the rules with no selectors (i.e. the unused rules) */
        if (rule.type === 'rule' && rule.selectors.length === 0) {
            return false;
        }
        /* Filter media queries with no remaining rules */
        if (rule.type === 'media' && rule.rules.length === 0) {
            return false;
        }
        return true;
    });
    return { stylesheet: { rules: rules } };
}

module.exports.phantom_eval = phantom_eval;
module.exports.mapReadFiles = mapReadFiles;
module.exports.extractStylesheets = extractStylesheets;
module.exports.filterUnusedRules = filterUnusedRules;