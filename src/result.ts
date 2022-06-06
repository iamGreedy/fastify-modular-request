export type Result<Ok, Fail> =
    | {
        result: 'ok'
        value: Ok
    }
    | {
        result: 'fail',
        value: Fail
    }
export namespace Result {
    export async function handle<Ok, Fail>(value: Result<Ok, Fail> | PromiseLike<Result<Ok, Fail>>, option: { ok?: (ok: Ok) => void, fail?: (fail: Fail) => void }) {
        const temp = await value
        if (temp.result === 'ok') {
            if (option.ok !== undefined) {
                option.ok(temp.value)
            }
        } else {
            if (option.fail !== undefined) {
                option.fail(temp.value)
            }
        }
    }
}

export type PResult<Ok, Fail> = Promise<Result<Ok, Fail>> & {
    ok(handler: (ok: Ok) => void): PResult<Ok, Fail>
    fail(handler: (fail: Fail) => void): PResult<Ok, Fail>
}
export function PResult<Ok, Fail>(wrap: Promise<Result<Ok, Fail>>): PResult<Ok, Fail> {
    const temp = wrap as PResult<Ok, Fail>
    temp.ok = function (handler) {
        return PResult(this.then(result => {
            if (result.result === 'ok') {
                handler(result.value)
            }
            return result
        }))
    }
    temp.fail = function (handler) {
        return PResult(this.then(result => {
            if (result.result === 'fail') {
                handler(result.value)
            }
            return result
        }))
    }
    return temp
}